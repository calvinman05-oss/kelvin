// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KelvinOracle} from "./KelvinOracle.sol";

/// @title KelvinVault
/// @notice Parametric cover priced by prediction markets, settled in native USDC on Arc.
///
///         A buyer picks a trigger — a set of mutually exclusive Gemini Prediction Markets
///         contracts, e.g. the three temperature buckets that together mean "Austin's high is
///         78°F or hotter" — and a payout. The premium is
///
///             payout x (sum of the buckets' implied probabilities + spread)
///
///         where the probabilities come from KelvinOracle (Gemini's live asks) and the spread
///         rises with pool utilisation. If any bucket resolves Yes the vault pays the buyer the
///         full payout; if all resolve No the premium is earned by the underwriting pool.
///
///         Underwriters deposit USDC and hold shares of the pool. Every policy is fully
///         collateralised: the payout is locked in the vault from sale to settlement.
///
/// @dev    On Arc, USDC is the native asset (18 decimals natively, 6 through the ERC-20 view).
///         Everything here moves native USDC through msg.value, so buying cover is ONE
///         transaction with no token approval and no second gas asset. All amounts are kept to
///         whole micro-dollars (multiples of 1e12 wei) so the native and ERC-20 views always agree.
contract KelvinVault {
    // ---- constants ----
    uint256 public constant UNIT = 1e12; // one micro-dollar of native USDC
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_LEGS = 8;
    uint256 public constant UNRESOLVED_GRACE = 7 days;

    // ---- configuration (owner) ----
    KelvinOracle public immutable oracle;
    address public owner;
    uint32 public maxStaleness = 15 minutes; // odds older than this cannot price a sale
    uint32 public salesCutoff = 6 minutes; // floor: never sell this close to a market's expiry
    uint16 public baseSpreadBps = 200; // 2 cents per $1 of payout
    uint16 public utilSpreadBps = 800; // extra spread at 100% utilisation (linear)
    uint16 public maxProbBps = 9_000; // do not sell cover that is already near-certain
    uint16 public minProbBps = 100; // floor: no market is priced below 1%
    uint16 public maxUtilBps = 8_000; // at most 80% of the pool may be locked
    uint16 public perEventCapBps = 3_000; // at most 30% of the pool on one Gemini event

    // ---- pool accounting ----
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    uint256 public lockedPayouts; // collateral reserved for open policies
    uint256 public unearnedPremiums; // premiums of open policies, not yet in NAV
    mapping(bytes32 => uint256) public eventExposure; // keccak(eventTicker) => locked payout

    // ---- policies ----
    enum PolicyStatus {
        None,
        Active,
        PaidOut, // trigger hit, payout sent to holder
        Expired, // trigger missed, premium earned by pool
        Refunded // oracle never resolved; premium returned
    }

    struct Policy {
        address holder;
        PolicyStatus status;
        uint64 boughtAt;
        uint64 expiry; // latest leg expiry
        uint16 probBps; // summed implied probability at sale
        uint16 spreadBps; // spread charged at sale
        uint256 payout;
        uint256 premium;
        bytes32 eventKey;
        bytes32[] legs; // oracle market ids; any Yes triggers the payout
    }

    Policy[] private _policies;
    mapping(address => uint256[]) private _policiesOf;
    mapping(address => uint256) public owed; // payouts whose push failed; pull with withdrawOwed()

    uint256 private _lock = 1;

    // ---- events ----
    event Deposited(address indexed lp, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lp, uint256 assets, uint256 shares);
    event CoverBought(
        uint256 indexed policyId,
        address indexed holder,
        bytes32 indexed eventKey,
        bytes32[] legs,
        uint256 payout,
        uint256 premium,
        uint16 probBps,
        uint16 spreadBps,
        uint64 expiry
    );
    event CoverSettled(uint256 indexed policyId, address indexed holder, PolicyStatus status, uint256 paid);
    event ConfigChanged();

    // ---- errors ----
    error NotOwner();
    error Reentrancy();
    error BadAmount();
    error BadLegs();
    error MarketNotOpen(bytes32 id);
    error StaleOdds(bytes32 id);
    error SalesClosed(bytes32 id);
    error MixedEvents();
    error TooLikely(uint256 probBps);
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);
    error WrongValue(uint256 sent, uint256 premium);
    error PoolUtilisation();
    error EventCap();
    error InsufficientLiquidity();
    error NotActive();
    error NotResolved();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(KelvinOracle oracle_) {
        oracle = oracle_;
        owner = msg.sender;
    }

    // =========================================================================
    // Underwriters
    // =========================================================================

    /// @notice Pool value owned by underwriters: cash minus premiums not yet earned.
    /// @dev    Locked collateral still belongs to the pool until a trigger is hit, so it counts.
    function totalAssets() public view returns (uint256) {
        return address(this).balance - unearnedPremiums - totalOwed;
    }

    uint256 public totalOwed;

    /// @notice Cash that is neither collateral for an open policy nor unearned premium.
    function freeLiquidity() public view returns (uint256) {
        uint256 reserved = lockedPayouts + unearnedPremiums + totalOwed;
        uint256 bal = address(this).balance;
        return bal > reserved ? bal - reserved : 0;
    }

    function sharePrice() external view returns (uint256) {
        return totalShares == 0 ? 1e18 : (totalAssets() * 1e18) / totalShares;
    }

    /// @notice Deposit native USDC to underwrite cover.
    function deposit() external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0 || msg.value % UNIT != 0) revert BadAmount();
        uint256 assetsBefore = totalAssets() - msg.value;
        shares = (totalShares == 0 || assetsBefore == 0) ? msg.value : (msg.value * totalShares) / assetsBefore;
        if (shares == 0) revert BadAmount();
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, msg.value, shares);
    }

    /// @notice Redeem shares for USDC, limited to liquidity not backing open policies.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert BadAmount();
        assets = (shares * totalAssets()) / totalShares;
        assets -= assets % UNIT;
        if (assets > freeLiquidity()) revert InsufficientLiquidity();
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        _send(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    // =========================================================================
    // Cover
    // =========================================================================

    /// @notice Price a cover without buying it.
    /// @return premium   native USDC to send with buyCover
    /// @return probBps   summed implied probability of the trigger
    /// @return spreadBps spread on top, including the utilisation surcharge
    function quote(bytes32[] calldata legs, uint256 payout)
        public
        view
        returns (uint256 premium, uint16 probBps, uint16 spreadBps, uint64 expiry, bytes32 eventKey)
    {
        if (payout == 0 || payout % UNIT != 0) revert BadAmount();
        uint256 n = legs.length;
        if (n == 0 || n > MAX_LEGS) revert BadLegs();

        uint256 prob;
        for (uint256 i; i < n; ++i) {
            for (uint256 j; j < i; ++j) {
                if (legs[j] == legs[i]) revert BadLegs();
            }
            (KelvinOracle.Status status, uint16 p, uint64 updatedAt, uint64 legExpiry, uint64 salesClose) =
                oracle.read(legs[i]);
            if (status != KelvinOracle.Status.Open) revert MarketNotOpen(legs[i]);
            if (block.timestamp > updatedAt + maxStaleness) revert StaleOdds(legs[i]);
            // sales stop before the outcome starts to be observed (set per market), and never
            // later than salesCutoff before expiry
            if (block.timestamp >= salesClose || block.timestamp + salesCutoff > legExpiry) {
                revert SalesClosed(legs[i]);
            }
            // every leg must belong to one Gemini event, so the legs are mutually exclusive
            bytes32 key = keccak256(bytes(oracle.getMarket(legs[i]).eventTicker));
            if (i == 0) eventKey = key;
            else if (key != eventKey) revert MixedEvents();
            prob += p < minProbBps ? minProbBps : p;
            if (legExpiry > expiry) expiry = legExpiry;
        }
        if (prob > maxProbBps) revert TooLikely(prob);

        uint256 pool = totalAssets();
        uint256 util = pool == 0 ? BPS : ((lockedPayouts + payout) * BPS) / pool;
        if (util > BPS) util = BPS;
        uint256 spread = baseSpreadBps + (uint256(utilSpreadBps) * util) / BPS;

        uint256 rateBps = prob + spread;
        if (rateBps > BPS) rateBps = BPS;
        premium = (payout * rateBps) / BPS;
        uint256 rem = premium % UNIT;
        if (rem != 0) premium += UNIT - rem; // round up to a whole micro-dollar

        probBps = uint16(prob);
        spreadBps = uint16(spread);
    }

    /// @notice Buy cover. Send the premium as native USDC; any excess is refunded.
    /// @param legs       oracle market ids making up the trigger (same Gemini event)
    /// @param payout     amount paid to you if any leg resolves Yes
    /// @param maxPremium slippage guard: revert if the premium moved above this
    function buyCover(bytes32[] calldata legs, uint256 payout, uint256 maxPremium)
        external
        payable
        nonReentrant
        returns (uint256 policyId)
    {
        // price against the pool as it was before this payment arrived
        (uint256 premium, uint16 probBps, uint16 spreadBps, uint64 expiry, bytes32 eventKey) =
            _quoteExcluding(legs, payout, msg.value);
        if (premium > maxPremium) revert PremiumTooHigh(premium, maxPremium);
        if (msg.value < premium) revert WrongValue(msg.value, premium);

        uint256 pool = totalAssets() - msg.value;
        if ((lockedPayouts + payout) * BPS > pool * maxUtilBps) revert PoolUtilisation();
        if ((eventExposure[eventKey] + payout) * BPS > pool * perEventCapBps) revert EventCap();

        lockedPayouts += payout;
        unearnedPremiums += premium;
        eventExposure[eventKey] += payout;

        policyId = _policies.length;
        _policies.push(
            Policy({
                holder: msg.sender,
                status: PolicyStatus.Active,
                boughtAt: uint64(block.timestamp),
                expiry: expiry,
                probBps: probBps,
                spreadBps: spreadBps,
                payout: payout,
                premium: premium,
                eventKey: eventKey,
                legs: legs
            })
        );
        _policiesOf[msg.sender].push(policyId);

        emit CoverBought(policyId, msg.sender, eventKey, legs, payout, premium, probBps, spreadBps, expiry);

        if (msg.value > premium) _send(msg.sender, msg.value - premium);
    }

    /// @notice Settle a policy once Gemini has resolved its markets. Anyone may call;
    ///         the payout always goes to the policy holder.
    function settle(uint256 policyId) public nonReentrant {
        Policy storage p = _policies[policyId];
        if (p.status != PolicyStatus.Active) revert NotActive();

        bool anyYes;
        bool allResolved = true;
        uint256 n = p.legs.length;
        for (uint256 i; i < n; ++i) {
            (KelvinOracle.Status status,,,,) = oracle.read(p.legs[i]);
            if (status == KelvinOracle.Status.Yes) {
                anyYes = true;
                break;
            }
            if (status != KelvinOracle.Status.No) allResolved = false;
        }

        if (anyYes) {
            _release(p);
            p.status = PolicyStatus.PaidOut;
            _pay(p.holder, p.payout);
            emit CoverSettled(policyId, p.holder, PolicyStatus.PaidOut, p.payout);
        } else if (allResolved) {
            _release(p);
            p.status = PolicyStatus.Expired; // premium is now earned by the pool
            emit CoverSettled(policyId, p.holder, PolicyStatus.Expired, 0);
        } else if (block.timestamp > uint256(p.expiry) + UNRESOLVED_GRACE) {
            // the oracle never reported: unwind the sale and hand the premium back
            lockedPayouts -= p.payout;
            eventExposure[p.eventKey] -= p.payout;
            unearnedPremiums -= p.premium;
            p.status = PolicyStatus.Refunded;
            _pay(p.holder, p.premium);
            emit CoverSettled(policyId, p.holder, PolicyStatus.Refunded, p.premium);
        } else {
            revert NotResolved();
        }
    }

    /// @notice Settle many policies; skips any that are not ready.
    function settleMany(uint256[] calldata policyIds) external {
        for (uint256 i; i < policyIds.length; ++i) {
            if (isSettleable(policyIds[i])) settle(policyIds[i]);
        }
    }

    function isSettleable(uint256 policyId) public view returns (bool) {
        if (policyId >= _policies.length) return false;
        Policy storage p = _policies[policyId];
        if (p.status != PolicyStatus.Active) return false;
        bool allResolved = true;
        for (uint256 i; i < p.legs.length; ++i) {
            (KelvinOracle.Status status,,,,) = oracle.read(p.legs[i]);
            if (status == KelvinOracle.Status.Yes) return true;
            if (status != KelvinOracle.Status.No) allResolved = false;
        }
        return allResolved || block.timestamp > uint256(p.expiry) + UNRESOLVED_GRACE;
    }

    /// @notice Collect a payout whose automatic transfer failed.
    function withdrawOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert BadAmount();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        _send(msg.sender, amount);
    }

    // ---- views ----

    function policyCount() external view returns (uint256) {
        return _policies.length;
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return _policies[policyId];
    }

    function policiesOf(address holder) external view returns (uint256[] memory) {
        return _policiesOf[holder];
    }

    /// @notice Newest policies first, for the public activity feed.
    function policiesPage(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Policy[] memory page)
    {
        uint256 total = _policies.length;
        if (offset >= total) return (new uint256[](0), new Policy[](0));
        uint256 n = total - offset < limit ? total - offset : limit;
        ids = new uint256[](n);
        page = new Policy[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = total - 1 - offset - i;
            page[i] = _policies[ids[i]];
        }
    }

    // ---- owner ----

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert BadAmount();
        owner = next;
    }

    function setConfig(
        uint32 maxStaleness_,
        uint32 salesCutoff_,
        uint16 baseSpreadBps_,
        uint16 utilSpreadBps_,
        uint16 maxProbBps_,
        uint16 minProbBps_,
        uint16 maxUtilBps_,
        uint16 perEventCapBps_
    ) external onlyOwner {
        if (maxProbBps_ > BPS || maxUtilBps_ > BPS || perEventCapBps_ > BPS || minProbBps_ == 0) {
            revert BadAmount();
        }
        maxStaleness = maxStaleness_;
        salesCutoff = salesCutoff_;
        baseSpreadBps = baseSpreadBps_;
        utilSpreadBps = utilSpreadBps_;
        maxProbBps = maxProbBps_;
        minProbBps = minProbBps_;
        maxUtilBps = maxUtilBps_;
        perEventCapBps = perEventCapBps_;
        emit ConfigChanged();
    }

    // ---- internals ----

    /// @dev quote() as it would have read before `incoming` wei arrived with this call.
    function _quoteExcluding(bytes32[] calldata legs, uint256 payout, uint256 incoming)
        private
        view
        returns (uint256 premium, uint16 probBps, uint16 spreadBps, uint64 expiry, bytes32 eventKey)
    {
        (premium, probBps, spreadBps, expiry, eventKey) = quote(legs, payout);
        if (incoming == 0) return (premium, probBps, spreadBps, expiry, eventKey);
        // re-derive the utilisation surcharge against the pre-payment pool
        uint256 pool = totalAssets() - incoming;
        uint256 util = pool == 0 ? BPS : ((lockedPayouts + payout) * BPS) / pool;
        if (util > BPS) util = BPS;
        uint256 spread = baseSpreadBps + (uint256(utilSpreadBps) * util) / BPS;
        uint256 rateBps = uint256(probBps) + spread;
        if (rateBps > BPS) rateBps = BPS;
        premium = (payout * rateBps) / BPS;
        uint256 rem = premium % UNIT;
        if (rem != 0) premium += UNIT - rem;
        spreadBps = uint16(spread);
    }

    function _release(Policy storage p) private {
        lockedPayouts -= p.payout;
        eventExposure[p.eventKey] -= p.payout;
        unearnedPremiums -= p.premium; // premium becomes pool NAV (or funds the payout)
    }

    /// @dev Push a payout; if the holder cannot receive it (e.g. a contract that rejects
    ///      value, or a blocklisted address on Arc), park it for withdrawOwed().
    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) {
            owed[to] += amount;
            totalOwed += amount;
        }
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {
        // donations raise the share price; used to seed first-loss capital
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KelvinOracle
/// @notice Mirrors Gemini Prediction Markets contracts on Arc: the live "Yes" ask as an
///         implied probability, and the final resolution once Gemini settles the contract.
///         Anyone on Arc can read it; only allow-listed keepers can write it.
/// @dev    A market id is keccak256(bytes(instrumentSymbol)), e.g.
///         keccak256("GEMI-WXHIGH-AUS-2611210459-78TO79").
contract KelvinOracle {
    enum Status {
        None, // never listed
        Open, // listed, odds being posted
        Yes, // Gemini resolved the contract to Yes
        No // Gemini resolved the contract to No
    }

    struct Market {
        Status status;
        uint16 probBps; // implied probability of Yes in basis points (the Gemini best ask)
        uint64 updatedAt; // when probBps was last posted
        uint64 expiry; // Gemini contract expiry (unix seconds)
        uint64 salesClose; // last moment cover may be sold on this market: before the outcome starts to be observed
        string symbol; // Gemini instrumentSymbol
        string eventTicker; // Gemini event ticker, e.g. WXHIGH-AUS-2611210459
        string label; // human label, e.g. "78°F to 79°F"
    }

    address public owner;
    mapping(address => bool) public isKeeper;
    mapping(bytes32 => Market) private _markets;
    bytes32[] public marketIds;

    event OwnerChanged(address indexed owner);
    event KeeperSet(address indexed keeper, bool allowed);
    event MarketListed(
        bytes32 indexed id, string symbol, string eventTicker, string label, uint64 expiry, uint64 salesClose
    );
    event OddsPosted(bytes32 indexed id, uint16 probBps, uint64 at);
    event MarketResolved(bytes32 indexed id, bool yes, uint64 at);

    error NotOwner();
    error NotKeeper();
    error BadInput();
    error UnknownMarket(bytes32 id);
    error AlreadyResolved(bytes32 id);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    constructor(address keeper) {
        owner = msg.sender;
        emit OwnerChanged(msg.sender);
        isKeeper[keeper] = true;
        emit KeeperSet(keeper, true);
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert BadInput();
        owner = next;
        emit OwnerChanged(next);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function idOf(string calldata symbol) external pure returns (bytes32) {
        return keccak256(bytes(symbol));
    }

    /// @notice List Gemini contracts so their odds can be posted. Idempotent.
    function listMarkets(
        string[] calldata symbols,
        string[] calldata eventTickers,
        string[] calldata labels,
        uint64[] calldata expiries,
        uint64[] calldata salesCloses
    ) external onlyKeeper {
        uint256 n = symbols.length;
        if (n != eventTickers.length || n != labels.length || n != expiries.length || n != salesCloses.length) {
            revert BadInput();
        }
        for (uint256 i; i < n; ++i) {
            bytes32 id = keccak256(bytes(symbols[i]));
            Market storage m = _markets[id];
            if (m.status != Status.None) continue;
            if (expiries[i] <= block.timestamp || salesCloses[i] > expiries[i]) revert BadInput();
            m.status = Status.Open;
            m.expiry = expiries[i];
            m.salesClose = salesCloses[i];
            m.symbol = symbols[i];
            m.eventTicker = eventTickers[i];
            m.label = labels[i];
            marketIds.push(id);
            emit MarketListed(id, symbols[i], eventTickers[i], labels[i], expiries[i], salesCloses[i]);
        }
    }

    /// @notice Post the latest implied probabilities (Gemini best ask, in bps).
    function postOdds(bytes32[] calldata ids, uint16[] calldata probsBps) external onlyKeeper {
        if (ids.length != probsBps.length) revert BadInput();
        uint64 nowTs = uint64(block.timestamp);
        for (uint256 i; i < ids.length; ++i) {
            Market storage m = _markets[ids[i]];
            if (m.status == Status.None) revert UnknownMarket(ids[i]);
            if (m.status != Status.Open) continue; // resolved: ignore late odds
            if (probsBps[i] > 10_000) revert BadInput();
            m.probBps = probsBps[i];
            m.updatedAt = nowTs;
            emit OddsPosted(ids[i], probsBps[i], nowTs);
        }
    }

    /// @notice Record Gemini's final resolution. One-way: a resolved market never changes.
    function resolve(bytes32[] calldata ids, bool[] calldata yes) external onlyKeeper {
        if (ids.length != yes.length) revert BadInput();
        for (uint256 i; i < ids.length; ++i) {
            Market storage m = _markets[ids[i]];
            if (m.status == Status.None) revert UnknownMarket(ids[i]);
            if (m.status != Status.Open) revert AlreadyResolved(ids[i]);
            m.status = yes[i] ? Status.Yes : Status.No;
            emit MarketResolved(ids[i], yes[i], uint64(block.timestamp));
        }
    }

    // ---- views ----

    function getMarket(bytes32 id) external view returns (Market memory) {
        return _markets[id];
    }

    /// @notice Compact read used by the vault.
    function read(bytes32 id)
        external
        view
        returns (Status status, uint16 probBps, uint64 updatedAt, uint64 expiry, uint64 salesClose)
    {
        Market storage m = _markets[id];
        return (m.status, m.probBps, m.updatedAt, m.expiry, m.salesClose);
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    /// @notice Page through listed markets, newest first.
    function listPage(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory ids, Market[] memory page)
    {
        uint256 total = marketIds.length;
        if (offset >= total) return (new bytes32[](0), new Market[](0));
        uint256 n = total - offset < limit ? total - offset : limit;
        ids = new bytes32[](n);
        page = new Market[](n);
        for (uint256 i; i < n; ++i) {
            bytes32 id = marketIds[total - 1 - offset - i];
            ids[i] = id;
            page[i] = _markets[id];
        }
    }
}

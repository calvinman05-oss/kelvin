// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KelvinOracle} from "../src/KelvinOracle.sol";
import {KelvinVault} from "../src/KelvinVault.sol";

contract Rejector {
    // cannot receive native USDC: stands in for a blocklisted or non-payable holder
    function buy(KelvinVault v, bytes32[] calldata legs, uint256 payout) external payable returns (uint256) {
        return v.buyCover{value: msg.value}(legs, payout, type(uint256).max);
    }
}

contract KelvinTest is Test {
    KelvinOracle oracle;
    KelvinVault vault;

    address keeper = address(0xBEEF);
    address lp = address(0x11);
    address lp2 = address(0x12);
    address buyer = address(0x21);

    uint256 constant USD = 1e18;
    string constant EVT = "WXHIGH-AUS-2611210459";
    bytes32 a; // 76-77F
    bytes32 b; // 78-79F
    bytes32 c; // 80-81F
    bytes32 other; // different event

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new KelvinOracle(keeper);
        vault = new KelvinVault(oracle);

        string[] memory syms = new string[](4);
        string[] memory evts = new string[](4);
        string[] memory labels = new string[](4);
        uint64[] memory exps = new uint64[](4);
        uint64[] memory closes = new uint64[](4);
        syms[0] = "GEMI-WXHIGH-AUS-2611210459-76TO77";
        syms[1] = "GEMI-WXHIGH-AUS-2611210459-78TO79";
        syms[2] = "GEMI-WXHIGH-AUS-2611210459-80TO81";
        syms[3] = "GEMI-WXHIGH-DFW-2611210459-76TO77";
        for (uint256 i; i < 4; ++i) {
            evts[i] = i < 3 ? EVT : "WXHIGH-DFW-2611210459";
            labels[i] = "bucket";
            exps[i] = uint64(block.timestamp + 1 days);
            closes[i] = uint64(block.timestamp + 11 hours); // 10am on the measured day
        }
        vm.prank(keeper);
        oracle.listMarkets(syms, evts, labels, exps, closes);
        a = keccak256(bytes(syms[0]));
        b = keccak256(bytes(syms[1]));
        c = keccak256(bytes(syms[2]));
        other = keccak256(bytes(syms[3]));
        _post(a, 6000);
        _post(b, 800);
        _post(c, 100);
        _post(other, 5000);

        vm.deal(lp, 1000 * USD);
        vm.deal(lp2, 1000 * USD);
        vm.deal(buyer, 100 * USD);
        vm.prank(lp);
        vault.deposit{value: 100 * USD}();
    }

    function _post(bytes32 id, uint16 p) internal {
        bytes32[] memory ids = new bytes32[](1);
        uint16[] memory ps = new uint16[](1);
        ids[0] = id;
        ps[0] = p;
        vm.prank(keeper);
        oracle.postOdds(ids, ps);
    }

    function _resolve(bytes32 id, bool yes) internal {
        bytes32[] memory ids = new bytes32[](1);
        bool[] memory ys = new bool[](1);
        ids[0] = id;
        ys[0] = yes;
        vm.prank(keeper);
        oracle.resolve(ids, ys);
    }

    function _legs(bytes32 x) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = x;
    }

    function _legs(bytes32 x, bytes32 y) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](2);
        l[0] = x;
        l[1] = y;
    }

    function _buy(bytes32[] memory legs, uint256 payout) internal returns (uint256 id, uint256 premium) {
        (premium,,,,) = vault.quote(legs, payout);
        vm.prank(buyer);
        id = vault.buyCover{value: premium}(legs, payout, premium);
    }

    // ---- pricing ----

    function test_quote_is_summed_odds_plus_spread() public view {
        // "78F or hotter" = 78-79 (8%) + 80-81 (1%) = 9% ; spread 2% + 8% * util(10/100) = 2.8%
        (uint256 premium, uint16 prob, uint16 spread,,) = vault.quote(_legs(b, c), 10 * USD);
        assertEq(prob, 900);
        assertEq(spread, 280);
        assertEq(premium, (10 * USD * 1180) / 10_000);
    }

    function test_probability_floor_applies() public {
        _post(c, 0);
        (, uint16 prob,,,) = vault.quote(_legs(c), 1 * USD);
        assertEq(prob, 100);
    }

    function test_buy_takes_exact_premium_and_refunds_excess() public {
        bytes32[] memory legs = _legs(b, c);
        (uint256 premium,,,,) = vault.quote(legs, 10 * USD);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        vault.buyCover{value: premium + 3 * USD}(legs, 10 * USD, premium);
        assertEq(before - buyer.balance, premium);
        assertEq(vault.lockedPayouts(), 10 * USD);
        assertEq(vault.unearnedPremiums(), premium);
        assertEq(vault.totalAssets(), 100 * USD); // unearned premium is not NAV yet
    }

    function test_buy_reverts_when_premium_moves_past_max() public {
        bytes32[] memory legs = _legs(b);
        (uint256 premium,,,,) = vault.quote(legs, 10 * USD);
        _post(b, 2000);
        vm.prank(buyer);
        vm.expectRevert();
        vault.buyCover{value: 10 * USD}(legs, 10 * USD, premium);
    }

    function test_stale_odds_block_sales() public {
        vm.warp(block.timestamp + 16 minutes);
        vm.expectRevert(abi.encodeWithSelector(KelvinVault.StaleOdds.selector, b));
        vault.quote(_legs(b), 1 * USD);
    }

    function test_sales_close_before_the_outcome_is_observed() public {
        // 13 hours of market life left, but the market's own sales window has shut
        vm.warp(block.timestamp + 11 hours);
        _post(b, 800);
        vm.expectRevert(abi.encodeWithSelector(KelvinVault.SalesClosed.selector, b));
        vault.quote(_legs(b), 1 * USD);
    }

    function test_near_certain_cover_is_refused() public {
        _post(a, 9500);
        vm.expectRevert(abi.encodeWithSelector(KelvinVault.TooLikely.selector, 9500));
        vault.quote(_legs(a), 1 * USD);
    }

    function test_legs_must_share_one_event() public {
        vm.expectRevert(KelvinVault.MixedEvents.selector);
        vault.quote(_legs(b, other), 1 * USD);
    }

    function test_duplicate_legs_rejected() public {
        vm.expectRevert(KelvinVault.BadLegs.selector);
        vault.quote(_legs(b, b), 1 * USD);
    }

    function test_per_event_cap() public {
        // cap is 30% of a 100 USDC pool
        bytes32[] memory legs = _legs(b);
        vm.prank(buyer);
        vm.expectRevert(KelvinVault.EventCap.selector);
        vault.buyCover{value: 31 * USD}(legs, 31 * USD, type(uint256).max);
    }

    // ---- settlement ----

    function test_trigger_hit_pays_holder_in_full() public {
        (uint256 id, uint256 premium) = _buy(_legs(b, c), 10 * USD);
        uint256 before = buyer.balance;
        _resolve(a, false);
        _resolve(b, true);
        vault.settle(id); // anyone can call
        assertEq(buyer.balance - before, 10 * USD);
        assertEq(vault.lockedPayouts(), 0);
        assertEq(vault.unearnedPremiums(), 0);
        assertEq(vault.totalAssets(), 100 * USD + premium - 10 * USD);
        assertEq(uint8(vault.getPolicy(id).status), uint8(KelvinVault.PolicyStatus.PaidOut));
    }

    function test_trigger_missed_premium_goes_to_pool() public {
        (uint256 id, uint256 premium) = _buy(_legs(b, c), 10 * USD);
        _resolve(b, false);
        vm.expectRevert(KelvinVault.NotResolved.selector);
        vault.settle(id);
        _resolve(c, false);
        vault.settle(id);
        assertEq(vault.totalAssets(), 100 * USD + premium);
        assertEq(uint8(vault.getPolicy(id).status), uint8(KelvinVault.PolicyStatus.Expired));
        vm.expectRevert(KelvinVault.NotActive.selector);
        vault.settle(id);
    }

    function test_unresolved_market_refunds_premium_after_grace() public {
        (uint256 id, uint256 premium) = _buy(_legs(b), 10 * USD);
        uint256 before = buyer.balance;
        vm.warp(block.timestamp + 1 days + 7 days + 1);
        vault.settle(id);
        assertEq(buyer.balance - before, premium);
        assertEq(vault.totalAssets(), 100 * USD);
        assertEq(vault.lockedPayouts(), 0);
    }

    function test_settleMany_skips_unready() public {
        (uint256 id0,) = _buy(_legs(b), 5 * USD);
        (uint256 id1,) = _buy(_legs(c), 5 * USD);
        _resolve(b, true);
        uint256[] memory ids = new uint256[](2);
        ids[0] = id0;
        ids[1] = id1;
        vault.settleMany(ids);
        assertEq(uint8(vault.getPolicy(id0).status), uint8(KelvinVault.PolicyStatus.PaidOut));
        assertEq(uint8(vault.getPolicy(id1).status), uint8(KelvinVault.PolicyStatus.Active));
    }

    function test_payout_to_unpayable_holder_is_parked_not_lost() public {
        Rejector r = new Rejector();
        vm.deal(address(this), 10 * USD);
        (uint256 premium,,,,) = vault.quote(_legs(c), 5 * USD);
        uint256 id = r.buy{value: premium}(vault, _legs(c), 5 * USD); // exact: it cannot take change
        _resolve(c, true);
        vault.settle(id);
        assertEq(vault.owed(address(r)), 5 * USD);
        assertEq(vault.totalOwed(), 5 * USD);
    }

    // ---- underwriters ----

    function test_lp_cannot_withdraw_locked_collateral() public {
        _buy(_legs(b), 20 * USD);
        uint256 shares = vault.sharesOf(lp);
        vm.prank(lp);
        vm.expectRevert(KelvinVault.InsufficientLiquidity.selector);
        vault.withdraw(shares);
        vm.prank(lp);
        vault.withdraw((shares * 80) / 100); // 80 of 100 is free
        assertEq(lp.balance, 900 * USD + 80 * USD);
    }

    function test_second_lp_does_not_capture_unearned_premium() public {
        (uint256 id, uint256 premium) = _buy(_legs(b), 20 * USD);
        vm.prank(lp2);
        uint256 s2 = vault.deposit{value: 100 * USD}();
        assertEq(s2, vault.sharesOf(lp)); // same price as the first LP paid
        _resolve(b, false);
        vault.settle(id);
        // premium is split pro rata between the two LPs who carried the risk
        assertApproxEqAbs(vault.totalAssets(), 200 * USD + premium, 1);
    }

    function test_share_price_reflects_losses() public {
        (uint256 id,) = _buy(_legs(b), 20 * USD);
        _resolve(b, true);
        vault.settle(id);
        assertLt(vault.sharePrice(), 1e18);
        uint256 shares = vault.sharesOf(lp);
        vm.prank(lp);
        uint256 out = vault.withdraw(shares);
        assertEq(address(vault).balance + out, 100 * USD + vault.getPolicy(id).premium - 20 * USD);
    }

    // ---- oracle ----

    function test_only_keeper_writes_and_resolution_is_final() public {
        bytes32[] memory ids = new bytes32[](1);
        uint16[] memory ps = new uint16[](1);
        ids[0] = a;
        vm.expectRevert(KelvinOracle.NotKeeper.selector);
        oracle.postOdds(ids, ps);
        _resolve(a, true);
        bool[] memory ys = new bool[](1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(KelvinOracle.AlreadyResolved.selector, a));
        oracle.resolve(ids, ys);
    }

    // ---- invariant-style fuzz: the vault can always cover what it has promised ----

    function testFuzz_solvent_after_any_sale(uint256 payoutUsd, uint16 probB) public {
        payoutUsd = bound(payoutUsd, 1, 30);
        probB = uint16(bound(probB, 0, 8000));
        _post(b, probB);
        bytes32[] memory legs = _legs(b);
        (uint256 premium,,,,) = vault.quote(legs, payoutUsd * USD);
        vm.prank(buyer);
        vault.buyCover{value: premium}(legs, payoutUsd * USD, premium);
        assertGe(address(vault).balance, vault.lockedPayouts() + vault.unearnedPremiums());
        assertEq(premium % 1e12, 0);
    }
}

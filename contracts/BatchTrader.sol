// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPool} from "./interfaces/IPool.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title BatchTrader
/// @notice EIP-7702 implementation contract.
///         address(this) == funded EOA, so all balances and approvals belong
///         to the wallet. Each executeBatch call runs up to maxCycles IOC
///         buy→sell round-trips inside a single transaction.
contract BatchTrader {
    /// @dev IPool order-type enum value for Immediate-Or-Cancel orders.
    uint8 constant IOC = 2;

    /// @notice Emitted once per executeBatch call, summarizing the run.
    /// @param pool DreamDEX SpotPool address the batch traded against
    /// @param cyclesCompleted number of buy→sell round-trips that fully completed
    /// @param amountPerCycle requested buy quantity per cycle (base token units)
    /// @param buyPrice IOC buy limit price used for every cycle
    /// @param sellPrice IOC sell limit price used for every cycle
    event BatchComplete(
        address indexed pool,
        uint256 cyclesCompleted,
        uint256 amountPerCycle,
        uint256 buyPrice,
        uint256 sellPrice
    );

    /// @notice `amount` or `maxCycles` was zero.
    error BadArgs();
    /// @notice The very first IOC buy of the batch was rejected or filled nothing.
    error BuyRejected();
    /// @notice The very first IOC sell of the batch was rejected.
    error SellRejected();
    /// @notice Every cycle failed, so no round-trip completed at all.
    error NoCyclesCompleted();

    /// @notice Runs up to `maxCycles` IOC buy→sell round-trips against `pool`
    ///         in a single call, stopping early (without reverting) once a
    ///         cycle after the first fails to buy or sell.
    /// @dev Grants max allowance to `pool` on both tokens every call; safe
    ///      because `address(this)` is the funded EOA itself under EIP-7702
    ///      delegation, so the allowance never outlives the wallet's intent
    ///      to keep using this implementation.
    /// @param pool       DreamDEX SpotPool address
    /// @param quote      Quote token (e.g. USDso)
    /// @param base       Base token (e.g. WETH)
    /// @param buyPrice   IOC buy limit price (pool price units)
    /// @param sellPrice  IOC sell limit price (pool price units)
    /// @param amount     Quantity per buy order (base token units)
    /// @param maxCycles  Max buy→sell repetitions per tx
    /// @param deadline   expireTimestampNs for each order (nanoseconds, fits uint64)
    function executeBatch(
        address pool,
        address quote,
        address base,
        uint256 buyPrice,
        uint256 sellPrice,
        uint256 amount,
        uint256 maxCycles,
        uint256 deadline
    ) external {
        if (amount == 0 || maxCycles == 0) revert BadArgs();

        // Wallet-auto-pull model: the pool pulls straight from address(this)
        // on each placeOrder call, so allowance must be set once up front
        // rather than per cycle.
        IERC20(quote).approve(pool, type(uint256).max);
        IERC20(base).approve(pool, type(uint256).max);

        uint256 cyclesDone;

        for (uint256 i = 0; i < maxCycles; i++) {
            uint256 baseBefore = IERC20(base).balanceOf(address(this));

            (bool buyOk,) = IPool(pool).placeOrder(
                true, 0, buyPrice, amount, uint64(deadline), IOC, 0, address(0), 0
            );
            if (!buyOk) {
                // Only the first cycle failing is an error; later failures just
                // mean liquidity/price moved, so stop and keep prior progress.
                if (i == 0) revert BuyRejected();
                break;
            }

            // Measure the fill via balance delta rather than trusting a filled
            // amount from the return value, since IOC orders can partial-fill.
            uint256 bought = IERC20(base).balanceOf(address(this)) - baseBefore;
            if (bought == 0) {
                if (i == 0) revert BuyRejected();
                break;
            }

            // Sell exactly what this cycle bought, not the requested `amount`,
            // so a partial buy fill can't leave the sell short of collateral.
            (bool sellOk,) = IPool(pool).placeOrder(
                false, 0, sellPrice, bought, uint64(deadline), IOC, 0, address(0), 0
            );
            if (!sellOk) {
                if (i == 0) revert SellRejected();
                break;
            }

            unchecked { cyclesDone++; }
        }

        if (cyclesDone == 0) revert NoCyclesCompleted();

        emit BatchComplete(pool, cyclesDone, amount, buyPrice, sellPrice);
    }

    receive() external payable {}
}

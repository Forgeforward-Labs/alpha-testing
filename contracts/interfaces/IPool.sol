// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice DreamDEX SpotPool post-June-2026 interface.
/// @dev Canonical sig: placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)
///      Selector: 0x4e978373
interface IPool {
    /// @notice Places an order against the pool. On the wallet-auto-pull model,
    ///         the pool pulls the paying side (quote for bids, base for asks)
    ///         directly from `msg.sender` and delivers the received side back
    ///         to `msg.sender` — no vault deposit/withdrawal step is required.
    /// @param isBid true for a buy (bid), false for a sell (ask)
    /// @param userData opaque tag echoed back in fills/events, caller-defined
    /// @param price limit price, in pool price units
    /// @param quantity order size, in base token units
    /// @param expireTimestampNs order expiry, unix time in nanoseconds
    /// @param orderType pool order-type enum (e.g. IOC, GTC)
    /// @param selfMatchingOption pool self-match-prevention policy enum
    /// @param builder optional builder/referrer address for fee attribution, or address(0)
    /// @param builderFeeBpsTimes1k builder fee, in basis points * 1000
    /// @return success whether the order was accepted (and, for IOC, filled at least partially)
    /// @return orderId pool-assigned order identifier
    function placeOrder(
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 orderId);
}

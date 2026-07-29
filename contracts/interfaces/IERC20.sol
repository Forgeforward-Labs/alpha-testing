// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal ERC-20 surface: only the calls BatchTrader needs to grant
///         pool allowances and measure fill sizes via balance deltas.
interface IERC20 {
    /// @notice Sets `spender`'s allowance over the caller's tokens to `amount`.
    /// @return true if the approval succeeded
    function approve(address spender, uint256 amount) external returns (bool);

    /// @notice Reads `account`'s token balance.
    function balanceOf(address account) external view returns (uint256);
}

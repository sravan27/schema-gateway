// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract SovereignPaywall is Ownable {
    using SafeERC20 for IERC20;

    struct TokenConfig {
        bool enabled;
        uint256 unitsPerCredit;
    }

    error InvalidAddress();
    error InvalidCommitment();
    error InvalidPrice();
    error UnsupportedToken(address token);
    error InsufficientPayment(uint256 amount, uint256 minimumAmount);

    address public treasury;
    uint256 public nativeUnitsPerCredit;
    mapping(address => TokenConfig) public tokenConfigs;

    event Purchase(
        address indexed buyer,
        address indexed token,
        uint256 amount,
        uint256 credits,
        bytes32 indexed keyCommitment
    );

    event NativePriceUpdated(uint256 unitsPerCredit);
    event TokenConfigured(address indexed token, bool enabled, uint256 unitsPerCredit);
    event TreasuryUpdated(address indexed treasury);

    constructor(address initialOwner, address initialTreasury, uint256 initialNativeUnitsPerCredit)
        Ownable(initialOwner)
    {
        if (initialOwner == address(0) || initialTreasury == address(0)) {
            revert InvalidAddress();
        }
        if (initialNativeUnitsPerCredit == 0) {
            revert InvalidPrice();
        }

        treasury = initialTreasury;
        nativeUnitsPerCredit = initialNativeUnitsPerCredit;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) {
            revert InvalidAddress();
        }

        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setNativeUnitsPerCredit(uint256 unitsPerCredit) external onlyOwner {
        if (unitsPerCredit == 0) {
            revert InvalidPrice();
        }

        nativeUnitsPerCredit = unitsPerCredit;
        emit NativePriceUpdated(unitsPerCredit);
    }

    function configureToken(address token, bool enabled, uint256 unitsPerCredit) external onlyOwner {
        if (token == address(0)) {
            revert InvalidAddress();
        }
        if (enabled && unitsPerCredit == 0) {
            revert InvalidPrice();
        }

        tokenConfigs[token] = TokenConfig({enabled: enabled, unitsPerCredit: unitsPerCredit});
        emit TokenConfigured(token, enabled, unitsPerCredit);
    }

    function quoteCredits(address token, uint256 amount) public view returns (uint256) {
        uint256 unitsPerCredit = token == address(0)
            ? nativeUnitsPerCredit
            : tokenConfigs[token].unitsPerCredit;

        if (unitsPerCredit == 0) {
            revert InvalidPrice();
        }

        return amount / unitsPerCredit;
    }

    function buyWithNative(bytes32 keyCommitment) external payable returns (uint256 credits) {
        if (keyCommitment == bytes32(0)) {
            revert InvalidCommitment();
        }

        credits = quoteCredits(address(0), msg.value);
        if (credits == 0) {
            revert InsufficientPayment(msg.value, nativeUnitsPerCredit);
        }

        emit Purchase(msg.sender, address(0), msg.value, credits, keyCommitment);
    }

    function buyWithToken(address token, uint256 amount, bytes32 keyCommitment)
        external
        returns (uint256 credits)
    {
        TokenConfig memory config = tokenConfigs[token];
        if (!config.enabled) {
            revert UnsupportedToken(token);
        }
        if (keyCommitment == bytes32(0)) {
            revert InvalidCommitment();
        }

        credits = quoteCredits(token, amount);
        if (credits == 0) {
            revert InsufficientPayment(amount, config.unitsPerCredit);
        }

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Purchase(msg.sender, token, amount, credits, keyCommitment);
    }

    function sweep(address token) external onlyOwner {
        if (token == address(0)) {
            (bool sent,) = treasury.call{value: address(this).balance}("");
            require(sent, "native transfer failed");
            return;
        }

        IERC20(token).safeTransfer(treasury, IERC20(token).balanceOf(address(this)));
    }
}

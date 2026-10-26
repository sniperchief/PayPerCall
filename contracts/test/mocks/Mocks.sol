// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// (1) 6-decimal USDC mimic: free mint, global transfer-failure switch, per-address blocklist,
/// and a global pause like FiatToken's (transfers revert while paused; mint stays open for setup).
contract MockUSDC is ERC20 {
    bool public failTransfers;
    bool public paused;
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFailTransfers(bool v) external {
        failTransfers = v;
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && paused) revert("MockUSDC: paused");
        if (from != address(0) && to != address(0) && failTransfers) revert("MockUSDC: transfers disabled");
        if (blocked[from] || blocked[to]) revert("MockUSDC: blocklisted");
        super._update(from, to, value);
    }
}

/// (2) Default OZ ERC20 => 18 decimals.
contract Mock18Token is ERC20 {
    constructor() ERC20("Mock18", "M18") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// (3a) decimals() reverts.
contract RevertingDecimalsToken {
    function decimals() external pure returns (uint8) {
        revert("no decimals");
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

/// (3b) Plain contract that is not an ERC20.
contract NotAToken {
    uint256 public x = 1;
}

/// (4) 6-decimal token that burns 1% on every transfer, so the receiver gets less than requested.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// (7) 6-decimal token whose transferFrom credits the recipient and then claws back twice the
/// amount to a sink, so the recipient ends with less than it had before the call.
contract BalanceDecreasingToken is ERC20 {
    address public constant SINK = address(0xdead);

    constructor() ERC20("Shrinking Token", "SHRINK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool ok = super.transferFrom(from, to, value);
        _update(to, SINK, 2 * value);
        return ok;
    }
}

/// (6) 6-decimal token whose transfer/transferFrom return false and move nothing.
contract ReturnsFalseToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// (5) 6-decimal token that, on transfer / transferFrom, fires one configurable low-level call
/// at `target` (msg.sender = this token). Useful for re-entering PayPerCall.
/// hook: 0 = off, 1 = on transferFrom, 2 = on transfer.
/// bubble: true => revert the whole transfer with the attack's revert data; false => swallow it
/// and record the outcome in attackSucceeded / attackRevertData.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public attackData;
    uint8 public hook;
    bool public bubble;
    bool public attackAttempted;
    bool public attackSucceeded;
    bytes public attackRevertData;

    constructor() ERC20("Reentrant USDC", "rUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTarget(address target_) external {
        target = target_;
    }

    function configure(bytes calldata data, uint8 hook_, bool bubble_) external {
        attackData = data;
        hook = hook_;
        bubble = bubble_;
        attackAttempted = false;
        attackSucceeded = false;
        delete attackRevertData;
    }

    /// Call `target` with this token as msg.sender (lets the token act as operator).
    function forward(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _attack(1);
        return super.transferFrom(from, to, value);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _attack(2);
        return super.transfer(to, value);
    }

    function _attack(uint8 which) internal {
        if (hook != which || attackAttempted) return;
        attackAttempted = true;
        (bool ok, bytes memory ret) = target.call(attackData);
        attackSucceeded = ok;
        if (!ok) {
            attackRevertData = ret;
            if (bubble) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

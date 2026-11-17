// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

enum GraduationPhase {
    NotGraduated,
    Swept,
    PoolCreated,
    Rescued
}

interface IPonsV2LaunchFactory {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        GraduationPhase phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}

interface IPonsV2BondingCurve {
    function graduated() external view returns (bool);
    function realQuoteReserve() external view returns (uint256);
    function graduationThreshold() external view returns (uint256);
    function buy(uint256 quoteIn, uint256 minOut, address recipient) external payable returns (uint256);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title SPUR Pit — Trustless 1v1 ETH Duels on Robinhood Chain Pons Markets
/// @notice Two wallets lock equal ETH stakes on live on-chain Pons token outcomes:
///         0 = GRADUATION (will tokenA graduate before resolveAt? Early KO the block it graduates)
///         1 = CURVE_LINE (will tokenA realQuoteReserve be >= targetValue at resolveAt, or graduate?)
///         2 = CLASH      (tokenA vs tokenB: first to graduate wins by KO, else higher realQuoteReserve at resolveAt)
///         3 = HAND_CHECK (will targetWallet hold 100% of its snapshot balance until resolveAt? Early KO on any sell)
///         Zero oracles, zero admin keys over funds. Every settled pot splits a 3% protocol cut across:
///         - Promoter Cut in ETH (0.5% of pot to a >=1M $SPURPIT staker who promoted/opened the bout)
///         - Ringside Stakers in ETH (1.25% of pot claimable immediately in ETH by $SPURPIT stakers)
///         - Autonomous Buyback & Burn (1.25%+ of pot buys $SPURPIT on Pons curve / V4 pool straight to 0x...dEaD)
contract SpurPit {
    enum Mode {
        GRADUATION,
        CURVE_LINE,
        CLASH,
        HAND_CHECK
    }

    enum Status {
        OPEN,
        LIVE,
        SETTLED,
        CANCELLED,
        DRAW
    }

    struct Bout {
        address maker;
        address taker;          // pre-named rival while OPEN (0 = anyone), actual opponent once LIVE
        address promoter;       // eligible for 0.5% pot ETH cut if staking >= PROMOTER_MIN at settlement
        address tokenA;
        address tokenB;         // second token in CLASH, or watched wallet in HAND_CHECK
        address curveA;
        address curveB;
        uint128 stake;          // ETH locked by each corner; pot = 2 * stake
        uint256 targetValue;    // reserve target in wei (CURVE_LINE) or snapshot token balance (HAND_CHECK)
        uint64 joinBy;          // last timestamp an opponent can match
        uint64 resolveAt;       // deadline timestamp for non-KO settlement
        Mode mode;
        bool makerSideA;        // true = YES / OVER / TOKEN_A / HOLD; false = NO / UNDER / TOKEN_B / DUMP
        Status status;
        address winner;
        uint32 featured;        // number of 50K $SPURPIT Main Event burns applied to this bout
    }

    struct OpenParams {
        Mode mode;
        bool makerSideA;
        address tokenA;
        address tokenB;         // tokenB for CLASH, or watched holder for HAND_CHECK (address(0) = deployer)
        address opponent;       // address(0) for open pit, or specific rival wallet
        address promoter;       // address(0) defaults to msg.sender
        uint256 targetValue;    // required only for CURVE_LINE (wei of realQuoteReserve)
        uint64 joinWindow;      // seconds open for matching (60 .. 7 days)
        uint64 duration;        // seconds from now to resolveAt (120 .. 30 days, > joinWindow)
        string callout;         // trash-talk / thesis emitted on-chain (<= 140 bytes)
    }

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    IPonsV2LaunchFactory public constant FACTORY = IPonsV2LaunchFactory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    IUniversalRouter public constant ROUTER = IUniversalRouter(0x8876789976dEcBfCbBbe364623C63652db8C0904);
    address public constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    uint256 public constant MIN_STAKE = 0.0005 ether;
    uint256 public constant MAX_STAKE = 50 ether;
    uint256 public constant FEE_BPS = 300;          // 3.00% of total pot
    uint256 public constant PROMOTER_BPS = 50;      // 0.50% of total pot in ETH
    uint256 public constant RINGSIDE_BPS = 125;     // 1.25% of total pot in ETH
    uint256 public constant IGNITE_TIP_BPS = 100;   // 1.00% of burn chunk paid to ignite() caller for gas
    uint256 public constant MIN_IGNITE = 0.0002 ether;
    uint256 public constant MAX_IGNITE = 0.5 ether;

    uint256 public constant PROMOTER_MIN = 1_000_000 ether; // 1M $SPURPIT staked unlocks Promoter ETH cuts
    uint256 public constant FEATURE_BURN = 50_000 ether;    // 50K $SPURPIT burned pins Main Event badge

    address public immutable deployer;

    // Bound once via bindSpur() right after the $SPURPIT token launches on Pons; immutable forever after.
    IERC20 public spur;
    IPonsV2BondingCurve public spurCurve;
    uint24 public spurPoolFee;
    int24 public spurTickSpacing;

    uint256 public nextBoutId = 1;
    mapping(uint256 => Bout) private _bouts;

    // Ringside $SPURPIT staking (earns real ETH on every settled bout, no lockup)
    uint256 public totalStaked;
    uint256 public accEthPerShare;
    mapping(address => uint256) public staked;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public pendingRingside;

    // Pull-claimable ETH (Promoter cuts + fallback if a smart-contract winner rejects direct push)
    mapping(address => uint256) public claimableEth;

    // Protocol telemetry & buyback bucket
    uint256 public burnBucket;
    uint256 public totalVolumeWei;
    uint256 public totalBoutsSettled;
    uint256 public totalRingsideEth;
    uint256 public totalPromoterEth;
    uint256 public totalBurnEthSpent;
    uint256 public totalSpurBurned;

    uint256 private _locked = 1;

    event SpurBound(address indexed token, address indexed curve, uint24 poolFee, int24 tickSpacing);
    event BoutOpened(
        uint256 indexed id,
        address indexed maker,
        address indexed opponent,
        Mode mode,
        bool makerSideA,
        address tokenA,
        address tokenB,
        uint256 stake,
        uint256 targetValue,
        uint64 joinBy,
        uint64 resolveAt,
        address promoter,
        string callout
    );
    event BoutMatched(uint256 indexed id, address indexed taker, uint256 pot);
    event BoutCancelled(uint256 indexed id, address indexed maker, uint256 refunded);
    event BoutSettled(
        uint256 indexed id,
        Status status,
        address indexed winner,
        uint256 payout,
        uint256 fee,
        bool earlyKo
    );
    event BoutFeatured(uint256 indexed id, address indexed burner, uint32 featuredCount, uint256 totalBurned);
    event Staked(address indexed user, uint256 amount, uint256 totalStaked);
    event Unstaked(address indexed user, uint256 amount, uint256 totalStaked);
    event EthClaimed(address indexed user, uint256 amount);
    event Ignited(address indexed caller, uint256 ethSpent, uint256 tipPaid, uint256 spurBurned, bool onCurve);

    error Reentrancy();
    error OnlyDeployer();
    error AlreadyBound();
    error SpurNotBound();
    error BadStake();
    error BadTiming();
    error BadCallout();
    error InvalidPonsToken();
    error AlreadyGraduatedToken();
    error SameTokens();
    error BadTarget();
    error EmptyHolderBag();
    error NotOpen();
    error JoinWindowClosed();
    error JoinWindowStillOpen();
    error ReservedForRival();
    error SelfMatch();
    error NotCancelable();
    error NotLive();
    error TooEarlyToSettle();
    error ZeroAmount();
    error InsufficientStake();
    error NothingToIgnite();
    error NothingBought();
    error EthTransferFailed();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor() {
        deployer = msg.sender;
    }

    receive() external payable {}

    /// @notice One-time binding after $SPURPIT launches on Pons. No admin functions remain afterwards.
    function bindSpur(address token_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (address(spur) != address(0)) revert AlreadyBound();
        IPonsV2LaunchFactory.LaunchedToken memory info = FACTORY.getLaunchedToken(token_);
        if (!info.exists || info.pairToken != address(0) || info.curve == address(0)) revert InvalidPonsToken();
        spur = IERC20(token_);
        spurCurve = IPonsV2BondingCurve(info.curve);
        spurPoolFee = info.poolFee;
        spurTickSpacing = info.tickSpacing;
        emit SpurBound(token_, info.curve, info.poolFee, info.tickSpacing);
    }

    /// @notice Opens a 1v1 ETH bout on a live Pons market condition.
    function openBout(OpenParams calldata p) external payable nonReentrant returns (uint256 id) {
        if (msg.value < MIN_STAKE || msg.value > MAX_STAKE) revert BadStake();
        if (p.joinWindow < 60 || p.joinWindow > 7 days) revert BadTiming();
        if (p.duration <= p.joinWindow || p.duration > 30 days) revert BadTiming();
        if (bytes(p.callout).length > 140) revert BadCallout();
        if (p.opponent == msg.sender) revert SelfMatch();

        IPonsV2LaunchFactory.LaunchedToken memory infoA = FACTORY.getLaunchedToken(p.tokenA);
        if (!infoA.exists || infoA.pairToken != address(0) || infoA.curve == address(0)) revert InvalidPonsToken();

        address secondAddr = p.tokenB;
        address curveB = address(0);
        uint256 target = p.targetValue;

        if (p.mode == Mode.GRADUATION) {
            if (_isGraduated(p.tokenA, infoA.curve)) revert AlreadyGraduatedToken();
            secondAddr = address(0);
            target = infoA.graduationThreshold;
        } else if (p.mode == Mode.CURVE_LINE) {
            if (_isGraduated(p.tokenA, infoA.curve)) revert AlreadyGraduatedToken();
            if (target == 0 || target > infoA.graduationThreshold) revert BadTarget();
            secondAddr = address(0);
        } else if (p.mode == Mode.CLASH) {
            if (p.tokenA == p.tokenB) revert SameTokens();
            IPonsV2LaunchFactory.LaunchedToken memory infoB = FACTORY.getLaunchedToken(p.tokenB);
            if (!infoB.exists || infoB.pairToken != address(0) || infoB.curve == address(0)) revert InvalidPonsToken();
            if (_isGraduated(p.tokenA, infoA.curve) || _isGraduated(p.tokenB, infoB.curve)) {
                revert AlreadyGraduatedToken();
            }
            curveB = infoB.curve;
            target = 0;
        } else if (p.mode == Mode.HAND_CHECK) {
            address watched = secondAddr == address(0) ? infoA.deployer : secondAddr;
            if (watched == address(0)) revert EmptyHolderBag();
            uint256 snap = IERC20(p.tokenA).balanceOf(watched);
            if (snap == 0) revert EmptyHolderBag();
            secondAddr = watched;
            target = snap;
        }

        address promo = p.promoter == address(0) ? msg.sender : p.promoter;
        uint64 joinBy = uint64(block.timestamp) + p.joinWindow;
        uint64 resolveAt = uint64(block.timestamp) + p.duration;

        id = nextBoutId++;
        Bout storage b = _bouts[id];
        b.maker = msg.sender;
        b.taker = p.opponent;
        b.promoter = promo;
        b.tokenA = p.tokenA;
        b.tokenB = secondAddr;
        b.curveA = infoA.curve;
        b.curveB = curveB;
        b.stake = uint128(msg.value);
        b.targetValue = target;
        b.joinBy = joinBy;
        b.resolveAt = resolveAt;
        b.mode = p.mode;
        b.makerSideA = p.makerSideA;
        b.status = Status.OPEN;

        emit BoutOpened(
            id,
            msg.sender,
            p.opponent,
            p.mode,
            p.makerSideA,
            p.tokenA,
            secondAddr,
            msg.value,
            target,
            joinBy,
            resolveAt,
            promo,
            p.callout
        );
    }

    /// @notice Accepts an open bout with an equal ETH stake and locks both corners in.
    function matchBout(uint256 id) external payable nonReentrant {
        Bout storage b = _bouts[id];
        if (b.status != Status.OPEN) revert NotOpen();
        if (block.timestamp > b.joinBy) revert JoinWindowClosed();
        if (msg.sender == b.maker) revert SelfMatch();
        if (b.taker != address(0) && msg.sender != b.taker) revert ReservedForRival();
        if (msg.value != uint256(b.stake)) revert BadStake();

        // Prevent matching into an already-decided KO state while the bout sat unmatched
        (bool earlyReady,,) = previewOutcome(id);
        if (earlyReady) revert JoinWindowClosed();

        b.taker = msg.sender;
        b.status = Status.LIVE;
        uint256 pot = uint256(b.stake) * 2;
        totalVolumeWei += pot;

        emit BoutMatched(id, msg.sender, pot);
    }

    /// @notice Refunds 100% of maker's stake if unmatched. Maker can cancel anytime; anyone can sweep after joinBy.
    function cancelBout(uint256 id) external nonReentrant {
        Bout storage b = _bouts[id];
        if (b.status != Status.OPEN) revert NotOpen();
        if (msg.sender != b.maker && block.timestamp <= b.joinBy) revert JoinWindowStillOpen();

        b.status = Status.CANCELLED;
        uint256 refund = uint256(b.stake);
        _deliverEth(b.maker, refund);
        emit BoutCancelled(id, b.maker, refund);
    }

    /// @notice Permissionless settlement via live Robinhood Chain state. Supports instant early KO!
    function settle(uint256 id) external nonReentrant {
        Bout storage b = _bouts[id];
        if (b.status != Status.LIVE) revert NotLive();

        (bool canSettle, bool isDraw, bool sideAWon) = previewOutcome(id);
        if (!canSettle) revert TooEarlyToSettle();

        uint256 stakeAmt = uint256(b.stake);
        uint256 pot = stakeAmt * 2;
        bool earlyKo = block.timestamp < b.resolveAt;
        totalBoutsSettled += 1;

        if (isDraw) {
            b.status = Status.DRAW;
            _deliverEth(b.maker, stakeAmt);
            _deliverEth(b.taker, stakeAmt);
            emit BoutSettled(id, Status.DRAW, address(0), pot, 0, earlyKo);
            return;
        }

        address winner = (sideAWon == b.makerSideA) ? b.maker : b.taker;
        b.status = Status.SETTLED;
        b.winner = winner;

        uint256 fee = (pot * FEE_BPS) / 10_000;
        uint256 payout = pot - fee;

        _routeFee(pot, fee, b.promoter, b.maker);
        _deliverEth(winner, payout);

        emit BoutSettled(id, Status.SETTLED, winner, payout, fee, earlyKo);
    }

    /// @notice Checks whether a bout can settle right now and which side wins from live Pons state.
    function previewOutcome(uint256 id) public view returns (bool canSettle, bool isDraw, bool sideAWon) {
        Bout storage b = _bouts[id];
        if (b.maker == address(0)) return (false, false, false);

        bool pastDeadline = block.timestamp >= b.resolveAt;

        if (b.mode == Mode.GRADUATION) {
            bool grad = _isGraduated(b.tokenA, b.curveA);
            if (grad) return (true, false, true); // Side A (YES) wins immediately on graduation
            if (pastDeadline) return (true, false, false); // Side B (NO) wins at deadline
            return (false, false, false);
        }

        if (b.mode == Mode.CURVE_LINE) {
            bool grad = _isGraduated(b.tokenA, b.curveA);
            if (grad) return (true, false, true); // Graduated curve hit 100% threshold -> OVER wins immediately
            if (!pastDeadline) return (false, false, false);
            uint256 reserve = IPonsV2BondingCurve(b.curveA).realQuoteReserve();
            return (true, false, reserve >= b.targetValue);
        }

        if (b.mode == Mode.CLASH) {
            bool gradA = _isGraduated(b.tokenA, b.curveA);
            bool gradB = _isGraduated(b.tokenB, b.curveB);
            if (gradA && gradB) return (true, true, false);
            if (gradA) return (true, false, true);  // Token A KO by graduation
            if (gradB) return (true, false, false); // Token B KO by graduation
            if (!pastDeadline) return (false, false, false);
            uint256 resA = IPonsV2BondingCurve(b.curveA).realQuoteReserve();
            uint256 resB = IPonsV2BondingCurve(b.curveB).realQuoteReserve();
            if (resA == resB) return (true, true, false);
            return (true, false, resA > resB);
        }

        // Mode.HAND_CHECK: tokenB holds the watched wallet, targetValue holds snapshot balance
        uint256 curBal = IERC20(b.tokenA).balanceOf(b.tokenB);
        if (curBal < b.targetValue) {
            return (true, false, false); // Side B (DUMP) wins by instant KO the block a single token leaves
        }
        if (pastDeadline) {
            return (true, false, true);  // Side A (HOLD) wins if 100% held past deadline
        }
        return (false, false, false);
    }

    /// @notice Burns 50,000 $SPURPIT straight to 0x...dEaD to pin Main Event status onto a bout.
    function featureBout(uint256 id) external nonReentrant {
        if (address(spur) == address(0)) revert SpurNotBound();
        Bout storage b = _bouts[id];
        if (b.status != Status.OPEN && b.status != Status.LIVE) revert NotOpen();

        uint256 deadBefore = spur.balanceOf(DEAD);
        bool ok = spur.transferFrom(msg.sender, DEAD, FEATURE_BURN);
        if (!ok) revert ZeroAmount();
        uint256 burned = spur.balanceOf(DEAD) - deadBefore;

        b.featured += 1;
        totalSpurBurned += burned;
        emit BoutFeatured(id, msg.sender, b.featured, totalSpurBurned);
    }

    // ─── Ringside $SPURPIT Staking (Real ETH Yield + Promoter Eligibility) ──────────

    function stakeSpur(uint256 amount) external nonReentrant {
        if (address(spur) == address(0)) revert SpurNotBound();
        if (amount == 0) revert ZeroAmount();
        _harvestRingside(msg.sender);

        uint256 before = spur.balanceOf(address(this));
        if (!spur.transferFrom(msg.sender, address(this), amount)) revert ZeroAmount();
        uint256 received = spur.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        staked[msg.sender] += received;
        totalStaked += received;
        rewardDebt[msg.sender] = (staked[msg.sender] * accEthPerShare) / 1e18;

        emit Staked(msg.sender, received, totalStaked);
    }

    function unstakeSpur(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (staked[msg.sender] < amount) revert InsufficientStake();
        _harvestRingside(msg.sender);

        staked[msg.sender] -= amount;
        totalStaked -= amount;
        rewardDebt[msg.sender] = (staked[msg.sender] * accEthPerShare) / 1e18;

        if (!spur.transfer(msg.sender, amount)) revert ZeroAmount();
        emit Unstaked(msg.sender, amount, totalStaked);
    }

    /// @notice Claims both Ringside staking ETH yield and any Promoter / fallback ETH in one transaction.
    function claimEth() external nonReentrant returns (uint256 payout) {
        _harvestRingside(msg.sender);
        payout = pendingRingside[msg.sender] + claimableEth[msg.sender];
        if (payout == 0) revert ZeroAmount();

        pendingRingside[msg.sender] = 0;
        claimableEth[msg.sender] = 0;

        (bool ok,) = payable(msg.sender).call{value: payout}("");
        if (!ok) revert EthTransferFailed();
        emit EthClaimed(msg.sender, payout);
    }

    function earnedEth(address user) external view returns (uint256 ringside, uint256 promoterOrFallback) {
        uint256 accrued = pendingRingside[user];
        if (staked[user] > 0) {
            accrued += ((staked[user] * accEthPerShare) / 1e18) - rewardDebt[user];
        }
        return (accrued, claimableEth[user]);
    }

    // ─── Autonomous $SPURPIT Buyback & Burn ─────────────────────────────────────────

    /// @notice Spends accumulated burnBucket ETH to buy $SPURPIT on Pons curve / V4 pool and burn it to 0x...dEaD.
    ///         Pays caller a 1% ETH tip so anyone or any keeper bot is paid to trigger burns.
    function ignite() external nonReentrant returns (uint256 spurBurned) {
        if (address(spur) == address(0)) revert SpurNotBound();
        uint256 available = burnBucket;
        if (available < MIN_IGNITE) revert NothingToIgnite();

        uint256 chunk = available > MAX_IGNITE ? MAX_IGNITE : available;
        uint256 tip = (chunk * IGNITE_TIP_BPS) / 10_000;
        uint256 maxSpend = chunk - tip;

        // Deduct full chunk up front; any unspent curve graduation refund is added back below.
        burnBucket = available - chunk;

        uint256 ethBeforeSwap = address(this).balance;
        uint256 deadBefore = spur.balanceOf(DEAD);
        bool onCurve = true;

        try spurCurve.buy{value: maxSpend}(maxSpend, 0, DEAD) {} catch {
            onCurve = false;
            _buyAndBurnInPool(maxSpend);
        }

        spurBurned = spur.balanceOf(DEAD) - deadBefore;
        if (spurBurned == 0) revert NothingBought();

        uint256 actualSpent = ethBeforeSwap - address(this).balance;
        if (maxSpend > actualSpent) {
            burnBucket += (maxSpend - actualSpent);
        }

        totalBurnEthSpent += actualSpent;
        totalSpurBurned += spurBurned;

        if (tip > 0) {
            _deliverEth(msg.sender, tip);
        }

        emit Ignited(msg.sender, actualSpent, tip, spurBurned, onCurve);
    }

    // ─── Views ───────────────────────────────────────────────────────────────────

    function getBout(uint256 id) external view returns (Bout memory) {
        return _bouts[id];
    }

    function getBouts(uint256 fromId, uint256 limit) external view returns (Bout[] memory out) {
        uint256 maxId = nextBoutId;
        if (fromId == 0 || fromId >= maxId) return new Bout[](0);
        uint256 end = fromId + limit;
        if (end > maxId) end = maxId;
        out = new Bout[](end - fromId);
        for (uint256 i = fromId; i < end; i++) {
            out[i - fromId] = _bouts[i];
        }
    }

    function pitStats()
        external
        view
        returns (
            uint256 boutsCreated,
            uint256 boutsSettled,
            uint256 volumeWei,
            uint256 stakedSpur,
            uint256 ringsideEth,
            uint256 promoterEth,
            uint256 pendingBurnWei,
            uint256 burnedEthWei,
            uint256 burnedSpur
        )
    {
        return (
            nextBoutId - 1,
            totalBoutsSettled,
            totalVolumeWei,
            totalStaked,
            totalRingsideEth,
            totalPromoterEth,
            burnBucket,
            totalBurnEthSpent,
            totalSpurBurned
        );
    }

    // ─── Internals ───────────────────────────────────────────────────────────────

    function _routeFee(uint256 pot, uint256 fee, address promoter, address maker) private {
        uint256 remaining = fee;

        // 1. Promoter Cut (0.50% of pot) if promoter or maker holds >= 1M $SPURPIT staked in the pit
        uint256 promoCut = (pot * PROMOTER_BPS) / 10_000;
        address eligiblePromo = address(0);
        if (promoter != address(0) && staked[promoter] >= PROMOTER_MIN) {
            eligiblePromo = promoter;
        } else if (staked[maker] >= PROMOTER_MIN) {
            eligiblePromo = maker;
        }
        if (eligiblePromo != address(0) && promoCut <= remaining) {
            claimableEth[eligiblePromo] += promoCut;
            totalPromoterEth += promoCut;
            remaining -= promoCut;
        }

        // 2. Ringside Stakers Yield (1.25% of pot) distributed immediately in ETH
        uint256 ringsideCut = (pot * RINGSIDE_BPS) / 10_000;
        if (totalStaked > 0 && ringsideCut <= remaining) {
            accEthPerShare += (ringsideCut * 1e18) / totalStaked;
            totalRingsideEth += ringsideCut;
            remaining -= ringsideCut;
        }

        // 3. Autonomous Buyback & Burn bucket gets the rest (1.25%..3.00% of pot)
        burnBucket += remaining;
    }

    function _harvestRingside(address user) private {
        uint256 userStaked = staked[user];
        if (userStaked > 0) {
            uint256 pending = ((userStaked * accEthPerShare) / 1e18) - rewardDebt[user];
            if (pending > 0) {
                pendingRingside[user] += pending;
            }
        }
    }

    function _deliverEth(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount, gas: 35_000}("");
        if (!ok) {
            claimableEth[to] += amount;
        }
    }

    function _isGraduated(address token, address curve) private view returns (bool) {
        if (IPonsV2BondingCurve(curve).graduated()) return true;
        IPonsV2LaunchFactory.LaunchedToken memory info = FACTORY.getLaunchedToken(token);
        return info.phase != GraduationPhase.NotGraduated;
    }

    function _buyAndBurnInPool(uint256 amount) private {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: PoolKey(address(0), address(spur), spurPoolFee, spurTickSpacing, PONS_HOOK),
                zeroForOne: true,
                amountIn: uint128(amount),
                amountOutMinimum: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(address(0), amount);
        params[2] = abi.encode(address(spur), uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        ROUTER.execute{value: amount}(hex"10", inputs, block.timestamp);

        uint256 bought = spur.balanceOf(address(this)) - totalStaked;
        if (bought > 0) {
            spur.transfer(DEAD, bought);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title RockPaperScissors
 * @notice On-chain Rock Paper Scissors — fixed bet 0.0005 ETH, 1% fee to owner.
 */
contract RockPaperScissors {
    enum Move { None, Rock, Paper, Scissors }
    enum GameState { Open, Committed, Finished }

    struct Game {
        address player1;
        address player2;
        bytes32 commitHash; // keccak256(abi.encodePacked(move, password))
        Move move1;
        Move move2;
        GameState state;
        address winner;
    }

    uint256 public constant BET = 0.000005 ether;
    uint256 public constant FEE_BPS = 100; // 1% = 100 / 10000

    address public immutable owner;
    uint256 public gameCounter;
    mapping(uint256 => Game) public games;

    event GameCreated(uint256 indexed gameId, address indexed player1);
    event GameJoined(uint256 indexed gameId, address indexed player2);
    event MoveRevealed(uint256 indexed gameId, address indexed player, Move move);
    event GameFinished(uint256 indexed gameId, address indexed winner, uint256 prize);

    error InvalidMove();
    error InvalidGameState();
    error InvalidCommit();
    error NotPlayer();
    error WrongBetAmount();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    // ── Player 1: commit move ────────────────────────────────────────────────
    function createGame(bytes32 commitHash) external payable returns (uint256 gameId) {
        if (msg.value != BET) revert WrongBetAmount();

        gameId = ++gameCounter;
        games[gameId] = Game({
            player1: msg.sender,
            player2: address(0),
            commitHash: commitHash,
            move1: Move.None,
            move2: Move.None,
            state: GameState.Open,
            winner: address(0)
        });
        emit GameCreated(gameId, msg.sender);
    }

    // ── Player 2: join & play openly ────────────────────────────────────────
    function joinGame(uint256 gameId, Move move) external payable {
        Game storage g = games[gameId];
        if (g.state != GameState.Open) revert InvalidGameState();
        if (msg.value != BET) revert WrongBetAmount();
        if (move == Move.None || move > Move.Scissors) revert InvalidMove();

        g.player2 = msg.sender;
        g.move2 = move;
        g.state = GameState.Committed;
        emit GameJoined(gameId, msg.sender);
    }

    // ── Player 1: reveal ────────────────────────────────────────────────────
    function reveal(uint256 gameId, Move move, bytes32 salt) external {
        Game storage g = games[gameId];
        if (g.state != GameState.Committed) revert InvalidGameState();
        if (msg.sender != g.player1) revert NotPlayer();
        if (move == Move.None || move > Move.Scissors) revert InvalidMove();
        if (keccak256(abi.encodePacked(move, salt)) != g.commitHash) revert InvalidCommit();

        g.move1 = move;
        emit MoveRevealed(gameId, msg.sender, move);

        _finish(gameId);
    }

    function claimNoOpponentPlayer2(uint256 gameId) external {
        Game storage g = games[gameId];
        if (g.state != GameState.Open) revert InvalidGameState();
        if (msg.sender != g.player2) revert NotPlayer();

        g.state = GameState.Finished;
        g.winner = g.player2;

        emit GameFinished(gameId, g.player2, BET);
        _send(g.player2, BET);
    }

    function claimNoOpponent(uint256 gameId) external {
        Game storage g = games[gameId];
        if (g.state != GameState.Open) revert InvalidGameState();
        if (msg.sender != g.player1) revert NotPlayer();

        g.state = GameState.Finished;
        g.winner = g.player1;

        emit GameFinished(gameId, g.player1, BET);
        _send(g.player1, BET);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────
    function _finish(uint256 gameId) internal {
        Game storage g = games[gameId];
        address winner = _evaluate(g.move1, g.move2, g.player1, g.player2);
        g.winner = winner;
        g.state = GameState.Finished;

        uint256 pot = BET * 2;

        if (winner == address(0)) {
            // Remis 
            emit GameFinished(gameId, address(0), 0);
            _send(g.player1, BET);
            _send(g.player2, BET);
        } else {
            // 1% fee do ownera
            uint256 fee = pot * FEE_BPS / 10_000;
            uint256 prize = pot - fee;
            emit GameFinished(gameId, winner, prize);
            _send(owner, fee);
            _send(winner, prize);
        }
    }

    function _evaluate(Move m1, Move m2, address p1, address p2)
        internal pure returns (address)
    {
        if (m1 == m2) return address(0);
        if (
            (m1 == Move.Rock     && m2 == Move.Scissors) ||
            (m1 == Move.Scissors && m2 == Move.Paper)    ||
            (m1 == Move.Paper    && m2 == Move.Rock)
        ) return p1;
        return p2;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function buildCommit(Move move, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(move, salt));
    }
}

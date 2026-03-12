// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title RockPaperScissors
 * @notice On-chain Rock Paper Scissors — fixed bet 0.0005 ETH, 1% fee to owner.
 *
 */
contract RockPaperScissors {
    enum Move { None, Rock, Paper, Scissors }

    struct Game {
        address payable player1;
        address payable player2;
        bytes32 commitHash; // keccak256(abi.encodePacked(move, password))
        uint128 betAmount;
        uint64 blockNumber;
        Move move2;
    }
    struct Stat {
        uint32 gamesWon;
        uint32 gamesLost;
        uint32 gamesDraw;
        uint32 gamesRock;
        uint32 gamesPaper;
        uint32 gamesScissors;
        Move lastMove;
    }

    uint256 public FEE = 0; // in 1/10_000

    address public owner;
    uint256 public gameCounter;
    mapping(uint256 => Game) public games;
    mapping(address => Stat) public stats;

    event GameCreated(uint256 indexed gameId, address indexed player1, uint128 betAmount);
    event GameJoined(uint256 indexed gameId, address indexed player2, Move move);
    event GameCanceled(uint256 indexed gameId);
    event GameClosed(uint256 indexed gameId, address indexed player2, uint256 betAmount);
    event GameFinished(uint256 indexed gameId, address indexed winner, uint256 betAmount);

    error InvalidMove();
    error NotOwner();
    error InvalidGameState();
    error InvalidCommit();
    error NotPlayer();
    error WrongBetAmount();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    function changeOwner(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
    }

    function changeFee(uint256 newFee) external {
        if (msg.sender != owner) revert NotOwner();
        FEE = newFee;
    }

    // ── Player 1: commit move ────────────────────────────────────────────────
    function createGame(bytes32 commitHash) external payable returns (uint256 gameId) {
        if (uint256(uint128(msg.value)) != msg.value) revert WrongBetAmount();
        games[gameCounter] = Game({
            player1: payable(msg.sender), // 0 indicates closed game
            player2: payable(address(0)),
            commitHash: commitHash,
            betAmount: uint128(msg.value),
            blockNumber: uint64(block.number),
            move2: Move.None
        });
        emit GameCreated(gameCounter, msg.sender, msg.value);
        gameCounter++;
    }

    function cancelGame(uint256 gameId) public {
        Game storage g = games[gameId];
        if (g.player1 != payable(msg.sender)) revert NotPlayer();
        if (g.player2 != payable(address(0)) || g.player1 == payable(address(0))) revert InvalidGameState();
        if (block.number - g.blockNumber < 128) revert InvalidGameState();
        g.player1 = payable(address(0));
        _send(msg.sender, g.betAmount);
        emit GameCanceled(gameId);
    }

    // ── Player 2: join & play openly ────────────────────────────────────────
    function joinGame(uint256 gameId, Move move) external payable {
        Game storage g = games[gameId];
        if (g.player1 == payable(msg.sender)) revert NotPlayer();
        if (g.player2 != payable(address(0)) || g.player1 == payable(address(0))) revert InvalidGameState();
        if (msg.value != g.betAmount) revert WrongBetAmount();
        if (move != Move.Rock && move != Move.Paper && move != Move.Scissors) revert InvalidMove();
        g.player2 = payable(msg.sender);
        g.move2 = move;
        g.blockNumber = uint64(block.number);
        emit GameJoined(gameId, msg.sender, move);
    }

    function closeGame(uint256 gameId) external {
        Game storage g = games[gameId];
        if (g.player2 != payable(msg.sender)) revert NotPlayer();
        if (g.player2 == payable(address(0)) || g.player1 == payable(address(0))) revert InvalidGameState();
        if (block.number - g.blockNumber < 256) revert InvalidGameState();
        g.player1 = payable(address(0));
        uint256 fee = g.betAmount * FEE / 10000;
        if(fee > 0) {
            _send(owner, fee);
        }
        _send(g.player2, 2 * g.betAmount - fee);
        emit GameClosed(gameId, msg.sender, g.betAmount);
    }

    // ── Player 1: reveal ────────────────────────────────────────────────────
    function reveal(uint256 gameId, Move move, bytes32 salt) external {
        Game storage g = games[gameId];
        if (g.player1 != payable(msg.sender)) revert NotPlayer();
        if (g.player2 == payable(address(0)) || g.player1 == payable(address(0))) revert InvalidGameState();
        if (move != Move.Rock && move != Move.Paper && move != Move.Scissors) revert InvalidMove();
        if (keccak256(abi.encodePacked(move, salt)) != g.commitHash) revert InvalidCommit();
        g.player1 = payable(address(0));
        address winner = _evaluate(move, g.move2, msg.sender, g.player2);
        if (winner == address(0)) {
            stats[msg.sender].gamesDraw++;
            stats[g.player2].gamesDraw++;
            _send(msg.sender, g.betAmount);
            _send(g.player2, g.betAmount);
        } else {
            if(winner == msg.sender) {
                stats[msg.sender].gamesWon++;
                stats[g.player2].gamesLost++;
            } else {
                stats[msg.sender].gamesLost++;
                stats[g.player2].gamesWon++;
            }
            uint256 fee = g.betAmount * FEE / 10000;
            if(fee > 0) {
                _send(owner, fee);
            }
            _send(winner, 2 * g.betAmount - fee);
        }
        stats[msg.sender].lastMove = move;
        if(move == Move.Rock) {
            stats[msg.sender].gamesRock++;
        } else if(move == Move.Paper) {
            stats[msg.sender].gamesPaper++;
        } else if(move == Move.Scissors) {
            stats[msg.sender].gamesScissors++;
        }
        stats[g.player2].lastMove = g.move2;
        if(g.move2 == Move.Rock) {
            stats[g.player2].gamesRock++;
        } else if(g.move2 == Move.Paper) {
            stats[g.player2].gamesPaper++;
        } else if(g.move2 == Move.Scissors) {
            stats[g.player2].gamesScissors++;
        }
        emit GameFinished(gameId, winner, g.betAmount);
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

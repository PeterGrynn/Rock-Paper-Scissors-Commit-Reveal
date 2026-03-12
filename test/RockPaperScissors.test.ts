import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { RockPaperScissors } from "../typechain-types";

const Move = { None: 0, Rock: 1, Paper: 2, Scissors: 3 } as const;
type MoveValue = (typeof Move)[keyof typeof Move];

const BET = ethers.parseEther("1");
const SALT = ethers.id("secret-salt");

function buildCommit(move: MoveValue, salt: string): string {
  return ethers.keccak256(
    ethers.solidityPacked(["uint8", "bytes32"], [move, salt])
  );
}

// ── Balance tracking helpers ─────────────────────────────────────────────────

type Balances = { player1: bigint; player2: bigint; owner: bigint };

async function snapBalances(
  player1: { address: string },
  player2: { address: string },
  owner: { address: string }
): Promise<Balances> {
  return {
    player1: await ethers.provider.getBalance(player1.address),
    player2: await ethers.provider.getBalance(player2.address),
    owner:   await ethers.provider.getBalance(owner.address),
  };
}

function diffBalances(before: Balances, after: Balances): Balances {
  return {
    player1: after.player1 - before.player1,
    player2: after.player2 - before.player2,
    owner:   after.owner   - before.owner,
  };
}

/** Gas cost of a single transaction (gasUsed × effectiveGasPrice). */
async function gasCost(tx: any): Promise<bigint> {
  const receipt = await tx.wait();
  return receipt.gasUsed * receipt.gasPrice;
}

function formatEth(wei: bigint): string {
  const sign = wei < 0n ? "-" : "+";
  const abs  = wei < 0n ? -wei : wei;
  return `${sign}${ethers.formatEther(abs)} ETH`;
}

describe("RockPaperScissors", () => {
  let rps: RockPaperScissors;
  let owner: any, player1: any, player2: any, other: any;

  beforeEach(async () => {
    [owner, player1, player2, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("RockPaperScissors");
    rps = await Factory.connect(owner).deploy();
  });

  // ── deployment ──────────────────────────────────────────────────────────────
  describe("deployment", () => {
    it("owner is set to deployer", async () => {
      expect(await rps.owner()).to.equal(owner.address);
    });

    it("FEE starts at 0", async () => {
      expect(await rps.FEE()).to.equal(0);
    });

    it("gameCounter starts at 0", async () => {
      expect(await rps.gameCounter()).to.equal(0);
    });
  });

  // ── changeOwner ─────────────────────────────────────────────────────────────
  describe("changeOwner", () => {
    it("owner can transfer ownership", async () => {
      await rps.connect(owner).changeOwner(other.address);
      expect(await rps.owner()).to.equal(other.address);
    });

    it("reverts if caller is not owner", async () => {
      await expect(
        rps.connect(player1).changeOwner(player1.address)
      ).to.be.revertedWithCustomError(rps, "NotOwner");
    });
  });

  // ── changeFee ───────────────────────────────────────────────────────────────
  describe("changeFee", () => {
    it("owner can change the fee", async () => {
      await rps.connect(owner).changeFee(100);
      expect(await rps.FEE()).to.equal(100);
    });

    it("reverts if caller is not owner", async () => {
      await expect(
        rps.connect(player1).changeFee(100)
      ).to.be.revertedWithCustomError(rps, "NotOwner");
    });
  });

  // ── buildCommit ─────────────────────────────────────────────────────────────
  describe("buildCommit", () => {
    it("returns the correct hash", async () => {
      expect(await rps.buildCommit(Move.Rock, SALT)).to.equal(buildCommit(Move.Rock, SALT));
    });

    it("different moves produce different hashes", async () => {
      const h1 = await rps.buildCommit(Move.Rock, SALT);
      const h2 = await rps.buildCommit(Move.Paper, SALT);
      expect(h1).to.not.equal(h2);
    });
  });

  // ── createGame ──────────────────────────────────────────────────────────────
  describe("createGame", () => {
    it("emits GameCreated with gameId=0, player1 address, and betAmount", async () => {
      const commit = buildCommit(Move.Rock, SALT);
      await expect(rps.connect(player1).createGame(commit, { value: BET }))
        .to.emit(rps, "GameCreated")
        .withArgs(0, player1.address, BET);
    });

    it("increments gameCounter after each game", async () => {
      const commit = buildCommit(Move.Rock, SALT);
      await rps.connect(player1).createGame(commit, { value: BET });
      expect(await rps.gameCounter()).to.equal(1);
      await rps.connect(player2).createGame(commit, { value: BET });
      expect(await rps.gameCounter()).to.equal(2);
    });

    it("second game gets gameId = 1", async () => {
      const commit = buildCommit(Move.Rock, SALT);
      await rps.connect(player1).createGame(commit, { value: BET });
      await expect(rps.connect(player2).createGame(commit, { value: BET }))
        .to.emit(rps, "GameCreated")
        .withArgs(1, player2.address, BET);
    });

    it("stores game data correctly", async () => {
      const commit = buildCommit(Move.Rock, SALT);
      await rps.connect(player1).createGame(commit, { value: BET });
      const game = await rps.games(0);
      expect(game.player1).to.equal(player1.address);
      expect(game.player2).to.equal(ethers.ZeroAddress);
      expect(game.commitHash).to.equal(commit);
      expect(game.betAmount).to.equal(BET);
      expect(game.move2).to.equal(Move.None);
    });
  });

  // ── cancelGame ──────────────────────────────────────────────────────────────
  describe("cancelGame", () => {
    beforeEach(async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
    });

    it("reverts if caller is not player1", async () => {
      await mine(128);
      await expect(
        rps.connect(other).cancelGame(0)
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });

    it("reverts if called too early (< 128 blocks)", async () => {
      await expect(
        rps.connect(player1).cancelGame(0)
      ).to.be.revertedWithCustomError(rps, "InvalidGameState");
    });

    it("emits GameCanceled after 128 blocks", async () => {
      await mine(128);
      await expect(rps.connect(player1).cancelGame(0))
        .to.emit(rps, "GameCanceled")
        .withArgs(0);
    });

    it("refunds BET to player1 after cancelGame", async () => {
      await mine(128);
      await expect(rps.connect(player1).cancelGame(0)).to.changeEtherBalance(
        player1, BET, { includeFee: false }
      );
    });

    it("reverts if game already has player2", async () => {
      await rps.connect(player2).joinGame(0, Move.Rock, { value: BET });
      await mine(128);
      await expect(
        rps.connect(player1).cancelGame(0)
      ).to.be.revertedWithCustomError(rps, "InvalidGameState");
    });

    it("reverts on second cancelGame attempt", async () => {
      await mine(128);
      await rps.connect(player1).cancelGame(0);
      await expect(
        rps.connect(player1).cancelGame(0)
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });
  });

  // ── joinGame ────────────────────────────────────────────────────────────────
  describe("joinGame", () => {
    beforeEach(async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
    });

    it("emits GameJoined with correct gameId, player2 address, and move", async () => {
      await expect(rps.connect(player2).joinGame(0, Move.Scissors, { value: BET }))
        .to.emit(rps, "GameJoined")
        .withArgs(0, player2.address, Move.Scissors);
    });

    it("reverts if player1 tries to join their own game", async () => {
      await expect(
        rps.connect(player1).joinGame(0, Move.Rock, { value: BET })
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });

    it("reverts if bet amount is too high", async () => {
      await expect(
        rps.connect(player2).joinGame(0, Move.Rock, { value: BET + 1n })
      ).to.be.revertedWithCustomError(rps, "WrongBetAmount");
    });

    it("reverts if bet amount is too low", async () => {
      await expect(
        rps.connect(player2).joinGame(0, Move.Rock, { value: BET - 1n })
      ).to.be.revertedWithCustomError(rps, "WrongBetAmount");
    });

    it("reverts if move is None", async () => {
      await expect(
        rps.connect(player2).joinGame(0, Move.None, { value: BET })
      ).to.be.revertedWithCustomError(rps, "InvalidMove");
    });

    it("reverts on second join attempt (game already taken)", async () => {
      await rps.connect(player2).joinGame(0, Move.Rock, { value: BET });
      await expect(
        rps.connect(other).joinGame(0, Move.Paper, { value: BET })
      ).to.be.revertedWithCustomError(rps, "InvalidGameState");
    });

    it("reverts if game is canceled (player1 = zero address)", async () => {
      await mine(128);
      await rps.connect(player1).cancelGame(0);
      await expect(
        rps.connect(player2).joinGame(0, Move.Rock, { value: BET })
      ).to.be.revertedWithCustomError(rps, "InvalidGameState");
    });
  });

  // ── closeGame ───────────────────────────────────────────────────────────────
  describe("closeGame", () => {
    beforeEach(async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
    });

    it("reverts if caller is not player2", async () => {
      await mine(256);
      await expect(
        rps.connect(other).closeGame(0)
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });

    it("reverts if called too early (< 256 blocks since join)", async () => {
      await expect(
        rps.connect(player2).closeGame(0)
      ).to.be.revertedWithCustomError(rps, "InvalidGameState");
    });

    it("emits GameClosed after 256 blocks", async () => {
      await mine(256);
      await expect(rps.connect(player2).closeGame(0))
        .to.emit(rps, "GameClosed")
        .withArgs(0, player2.address, BET);
    });

    it("pays full pot 2×BET to player2 after closeGame", async () => {
      await mine(256);
      await expect(rps.connect(player2).closeGame(0)).to.changeEtherBalance(
        // player2 receives the full pot (2×BET) on closeGame
        player2, BET * 2n, { includeFee: false }
      );
    });

    it("reverts if game has no player2 (Open, not Committed)", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await mine(256);
      await expect(
        rps.connect(player2).closeGame(1)
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });

    it("reverts on second closeGame attempt", async () => {
      await mine(256);
      await rps.connect(player2).closeGame(0);
      // player1 is zeroed out after closeGame, so InvalidGameState
      await expect(
        rps.connect(player2).closeGame(0)
      ).to.be.revertedWithCustomError(rps, "InvalidGameState");
    });
  });

  // ── reveal ──────────────────────────────────────────────────────────────────
  describe("reveal", () => {
    async function setupGame(move1: MoveValue, move2: MoveValue) {
      await rps.connect(player1).createGame(buildCommit(move1, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, move2, { value: BET });
    }

    it("player1 wins: Rock beats Scissors", async () => {
      await setupGame(Move.Rock, Move.Scissors);
      await expect(rps.connect(player1).reveal(0, Move.Rock, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, player1.address, BET);
    });

    it("player1 wins: Paper beats Rock", async () => {
      await setupGame(Move.Paper, Move.Rock);
      await expect(rps.connect(player1).reveal(0, Move.Paper, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, player1.address, BET);
    });

    it("player1 wins: Scissors beats Paper", async () => {
      await setupGame(Move.Scissors, Move.Paper);
      await expect(rps.connect(player1).reveal(0, Move.Scissors, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, player1.address, BET);
    });

    it("player2 wins: Scissors beats Paper (player2=Scissors)", async () => {
      await setupGame(Move.Paper, Move.Scissors);
      await expect(rps.connect(player1).reveal(0, Move.Paper, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, player2.address, BET);
    });

    it("player2 wins: Rock beats Scissors (player2=Rock)", async () => {
      await setupGame(Move.Scissors, Move.Rock);
      await expect(rps.connect(player1).reveal(0, Move.Scissors, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, player2.address, BET);
    });

    it("player2 wins: Paper beats Rock (player2=Paper)", async () => {
      await setupGame(Move.Rock, Move.Paper);
      await expect(rps.connect(player1).reveal(0, Move.Rock, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, player2.address, BET);
    });

    it("draw Rock vs Rock — winner is ZeroAddress", async () => {
      await setupGame(Move.Rock, Move.Rock);
      await expect(rps.connect(player1).reveal(0, Move.Rock, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, ethers.ZeroAddress, BET);
    });

    it("draw Paper vs Paper — winner is ZeroAddress", async () => {
      await setupGame(Move.Paper, Move.Paper);
      await expect(rps.connect(player1).reveal(0, Move.Paper, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, ethers.ZeroAddress, BET);
    });

    it("draw Scissors vs Scissors — winner is ZeroAddress", async () => {
      await setupGame(Move.Scissors, Move.Scissors);
      await expect(rps.connect(player1).reveal(0, Move.Scissors, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(0, ethers.ZeroAddress, BET);
    });

    it("reverts with wrong salt", async () => {
      await setupGame(Move.Rock, Move.Scissors);
      await expect(
        rps.connect(player1).reveal(0, Move.Rock, ethers.id("wrong"))
      ).to.be.revertedWithCustomError(rps, "InvalidCommit");
    });

    it("reverts with wrong move (does not match commit)", async () => {
      await setupGame(Move.Rock, Move.Scissors);
      await expect(
        rps.connect(player1).reveal(0, Move.Paper, SALT)
      ).to.be.revertedWithCustomError(rps, "InvalidCommit");
    });

    it("reverts if move is None", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.None, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Rock, { value: BET });
      await expect(
        rps.connect(player1).reveal(0, Move.None, SALT)
      ).to.be.revertedWithCustomError(rps, "InvalidMove");
    });

    it("reverts if caller is not player1 (player2 attempts reveal)", async () => {
      await setupGame(Move.Rock, Move.Scissors);
      await expect(
        rps.connect(player2).reveal(0, Move.Rock, SALT)
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });

    it("reverts if caller is a third party", async () => {
      await setupGame(Move.Rock, Move.Scissors);
      await expect(
        rps.connect(other).reveal(0, Move.Rock, SALT)
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });

    describe("reveal with no player2", () => {
      it("reverts with InvalidGameState if there is no player2", async () => {
        await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
        await mine(128);
        await expect(
          rps.connect(player1).reveal(0, Move.Rock, SALT)
        ).to.be.revertedWithCustomError(rps, "InvalidGameState");
      });
    });
  });

  // ── ETH balances (FEE = 0) ──────────────────────────────────────────────────
  describe("ETH balances — FEE = 0", () => {
    it("winner (player1) receives the full pot 2×BET, others get 0", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      await expect(rps.connect(player1).reveal(0, Move.Rock, SALT)).to.changeEtherBalances(
        [player1, player2, owner],
        [BET * 2n, 0n, 0n],
        { includeFee: false }
      );
    });

    it("winner (player2) receives the full pot 2×BET, others get 0", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Scissors, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Rock, { value: BET });
      await expect(rps.connect(player1).reveal(0, Move.Scissors, SALT)).to.changeEtherBalances(
        [player1, player2, owner],
        [0n, BET * 2n, 0n],
        { includeFee: false }
      );
    });

    it("draw — both players get BET back, owner gets 0", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Rock, { value: BET });
      await expect(rps.connect(player1).reveal(0, Move.Rock, SALT)).to.changeEtherBalances(
        [player1, player2, owner],
        [BET, BET, 0n],
        { includeFee: false }
      );
    });

    it("cancelGame — player1 gets full BET refund", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await mine(128);
      await expect(rps.connect(player1).cancelGame(0)).to.changeEtherBalance(
        player1, BET, { includeFee: false }
      );
    });

    it("closeGame — player2 wins the full pot 2×BET (player1 loses their bet)", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      await mine(256);
      await expect(rps.connect(player2).closeGame(0)).to.changeEtherBalances(
        [player1, player2, owner],
        // closeGame pays the whole pot to player2
        [0n, BET * 2n, 0n],
        { includeFee: false }
      );
    });
  });

  // ── ETH balances (FEE = 1%) ─────────────────────────────────────────────────
  describe("ETH balances — FEE = 1%", () => {
    const FEE_BPS = 100n;
    // fee is calculated on betAmount (not 2×betAmount): g.betAmount * FEE / 10000
    const fee = (BET * FEE_BPS) / 10_000n;
    const prize = BET * 2n - fee;

    beforeEach(async () => {
      await rps.connect(owner).changeFee(FEE_BPS);
    });

    it("winner receives 99% of pot, owner receives 1%", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      await expect(rps.connect(player1).reveal(0, Move.Rock, SALT)).to.changeEtherBalances(
        [player1, owner],
        [prize, fee],
        { includeFee: false }
      );
    });

    it("draw — full refund with no fee, owner gets 0", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Rock, { value: BET });
      await expect(rps.connect(player1).reveal(0, Move.Rock, SALT)).to.changeEtherBalances(
        [player1, player2, owner],
        [BET, BET, 0n],
        { includeFee: false }
      );
    });
  });

  // ── stats ───────────────────────────────────────────────────────────────────
  describe("stats", () => {
    it("updates player1 stats after winning with Rock", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      await rps.connect(player1).reveal(0, Move.Rock, SALT);

      const s = await rps.stats(player1.address);
      expect(s.gamesWon).to.equal(1);
      expect(s.gamesLost).to.equal(0);
      expect(s.gamesDraw).to.equal(0);
      expect(s.gamesRock).to.equal(1);
      expect(s.gamesPaper).to.equal(0);
      expect(s.gamesScissors).to.equal(0);
      expect(s.lastMove).to.equal(Move.Rock);
    });

    it("updates player2 stats after losing with Scissors", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      await rps.connect(player1).reveal(0, Move.Rock, SALT);

      const s = await rps.stats(player2.address);
      expect(s.gamesWon).to.equal(0);
      expect(s.gamesLost).to.equal(1);
      expect(s.gamesDraw).to.equal(0);
      expect(s.gamesScissors).to.equal(1);
      expect(s.lastMove).to.equal(Move.Scissors);
    });

    it("updates stats after player2 wins", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Scissors, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Rock, { value: BET });
      await rps.connect(player1).reveal(0, Move.Scissors, SALT);

      const s1 = await rps.stats(player1.address);
      const s2 = await rps.stats(player2.address);
      expect(s1.gamesLost).to.equal(1);
      expect(s1.gamesScissors).to.equal(1);
      expect(s2.gamesWon).to.equal(1);
      expect(s2.gamesRock).to.equal(1);
    });

    it("updates stats after a draw (Paper vs Paper)", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Paper, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Paper, { value: BET });
      await rps.connect(player1).reveal(0, Move.Paper, SALT);

      const s1 = await rps.stats(player1.address);
      const s2 = await rps.stats(player2.address);
      expect(s1.gamesDraw).to.equal(1);
      expect(s1.gamesPaper).to.equal(1);
      expect(s1.lastMove).to.equal(Move.Paper);
      expect(s2.gamesDraw).to.equal(1);
      expect(s2.gamesPaper).to.equal(1);
      expect(s2.lastMove).to.equal(Move.Paper);
    });

    it("accumulates stats across multiple games", async () => {
      const SALT2 = ethers.id("salt2");

      // game 0: player1 Rock vs player2 Scissors → player1 wins
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      await rps.connect(player1).reveal(0, Move.Rock, SALT);

      // game 1: player1 Paper vs player2 Paper → draw
      await rps.connect(player1).createGame(buildCommit(Move.Paper, SALT2), { value: BET });
      await rps.connect(player2).joinGame(1, Move.Paper, { value: BET });
      await rps.connect(player1).reveal(1, Move.Paper, SALT2);

      const s1 = await rps.stats(player1.address);
      expect(s1.gamesWon).to.equal(1);
      expect(s1.gamesDraw).to.equal(1);
      expect(s1.gamesRock).to.equal(1);
      expect(s1.gamesPaper).to.equal(1);
      expect(s1.lastMove).to.equal(Move.Paper); // last move played
    });
  });

  // ── ETH snapshots — balance comparison before and after game ────────────────
  //
  // Each test:
  //   1. snapshots balances before the game
  //   2. plays the full game, tracking gas cost of each tx
  //   3. snapshots balances after the game
  //   4. computes rawDiff   = balance_after − balance_before   (includes gas)
  //             gameResult  = rawDiff + gasSpent               (strips gas out)
  //   5. prints a table and asserts the pure game outcome
  //
  // gameResult > 0  →  player gained ETH from the game
  // gameResult < 0  →  player lost ETH on the game
  // gameResult = 0  →  draw / no net loss
  // ---------------------------------------------------------------------------
  describe("ETH snapshots — balance before and after game", () => {

    function printTable(
      label: string,
      before: Balances,
      after: Balances,
      gasSpent: { player1: bigint; player2: bigint; owner: bigint },
      gameResult: Balances
    ) {
      const raw = diffBalances(before, after);
      console.log(`\n  ┌─ ${label}`);
      console.log("  │              before               after          rawDiff (with gas)    game result (no gas)");
      for (const role of ["player1", "player2", "owner"] as const) {
        console.log(
          `  │  ${role.padEnd(8)}  ${ethers.formatEther(before[role]).padStart(20)} ETH` +
          `  ${ethers.formatEther(after[role]).padStart(20)} ETH` +
          `  ${formatEth(raw[role]).padStart(20)}` +
          `  ${formatEth(gameResult[role]).padStart(20)}`
        );
      }
      console.log(`  │  gas:  player1 ${formatEth(gasSpent.player1).padStart(20)}   player2 ${formatEth(gasSpent.player2).padStart(20)}`);
      console.log("  └─");
    }

    it("player1 wins (Rock vs Scissors) — FEE = 0", async () => {
      const before = await snapBalances(player1, player2, owner);

      const tx1 = await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      const tx2 = await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      const tx3 = await rps.connect(player1).reveal(0, Move.Rock, SALT);

      const after = await snapBalances(player1, player2, owner);

      const gas1 = (await gasCost(tx1)) + (await gasCost(tx3)); // player1: create + reveal
      const gas2 = await gasCost(tx2);                           // player2: join
      const gasSpent = { player1: gas1, player2: gas2, owner: 0n };

      const raw = diffBalances(before, after);
      const gameResult: Balances = {
        player1: raw.player1 + gas1,  // strip gas → pure game result
        player2: raw.player2 + gas2,
        owner:   raw.owner,
      };

      printTable("player1 wins (Rock vs Scissors) — FEE = 0", before, after, gasSpent, gameResult);

      // player1: paid BET, received 2×BET → net +BET
      expect(gameResult.player1).to.equal(BET);
      // player2: paid BET, received 0 → net −BET
      expect(gameResult.player2).to.equal(-BET);
      // owner: no fee
      expect(gameResult.owner).to.equal(0n);
    });

    it("player2 wins (Paper vs Scissors) — FEE = 0", async () => {
      const before = await snapBalances(player1, player2, owner);

      const tx1 = await rps.connect(player1).createGame(buildCommit(Move.Paper, SALT), { value: BET });
      const tx2 = await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      const tx3 = await rps.connect(player1).reveal(0, Move.Paper, SALT);

      const after = await snapBalances(player1, player2, owner);

      const gas1 = (await gasCost(tx1)) + (await gasCost(tx3));
      const gas2 = await gasCost(tx2);
      const gasSpent = { player1: gas1, player2: gas2, owner: 0n };

      const raw = diffBalances(before, after);
      const gameResult: Balances = {
        player1: raw.player1 + gas1,
        player2: raw.player2 + gas2,
        owner:   raw.owner,
      };

      printTable("player2 wins (Paper vs Scissors) — FEE = 0", before, after, gasSpent, gameResult);

      expect(gameResult.player1).to.equal(-BET);  // lost
      expect(gameResult.player2).to.equal(BET);   // won
      expect(gameResult.owner).to.equal(0n);
    });

    it("draw (Rock vs Rock) — FEE = 0", async () => {
      const before = await snapBalances(player1, player2, owner);

      const tx1 = await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      const tx2 = await rps.connect(player2).joinGame(0, Move.Rock, { value: BET });
      const tx3 = await rps.connect(player1).reveal(0, Move.Rock, SALT);

      const after = await snapBalances(player1, player2, owner);

      const gas1 = (await gasCost(tx1)) + (await gasCost(tx3));
      const gas2 = await gasCost(tx2);
      const gasSpent = { player1: gas1, player2: gas2, owner: 0n };

      const raw = diffBalances(before, after);
      const gameResult: Balances = {
        player1: raw.player1 + gas1,
        player2: raw.player2 + gas2,
        owner:   raw.owner,
      };

      printTable("draw (Rock vs Rock) — FEE = 0", before, after, gasSpent, gameResult);

      expect(gameResult.player1).to.equal(0n);  // full refund
      expect(gameResult.player2).to.equal(0n);
      expect(gameResult.owner).to.equal(0n);
    });

    it("player1 wins (Rock vs Scissors) — FEE = 1%", async () => {
      await rps.connect(owner).changeFee(100);

      const before = await snapBalances(player1, player2, owner);

      const tx1 = await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      const tx2 = await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      const tx3 = await rps.connect(player1).reveal(0, Move.Rock, SALT);

      const after = await snapBalances(player1, player2, owner);

      const gas1 = (await gasCost(tx1)) + (await gasCost(tx3));
      const gas2 = await gasCost(tx2);
      const gasSpent = { player1: gas1, player2: gas2, owner: 0n };

      const fee   = BET * 100n / 10_000n;  // fee = betAmount × 1%
      const prize = BET * 2n - fee;

      const raw = diffBalances(before, after);
      const gameResult: Balances = {
        player1: raw.player1 + gas1,
        player2: raw.player2 + gas2,
        owner:   raw.owner,
      };

      printTable("player1 wins (Rock vs Scissors) — FEE = 1%", before, after, gasSpent, gameResult);

      // player1 paid BET, received prize = 2×BET − fee → net = prize − BET = BET − fee
      expect(gameResult.player1).to.equal(BET - fee);
      expect(gameResult.player2).to.equal(-BET);
      expect(gameResult.owner).to.equal(fee);
    });

    it("cancelGame — player1 cancels after 128 blocks (no opponent)", async () => {
      const before = await snapBalances(player1, player2, owner);

      const tx1 = await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await mine(128);
      const tx2 = await rps.connect(player1).cancelGame(0);

      const after = await snapBalances(player1, player2, owner);

      const gas1 = (await gasCost(tx1)) + (await gasCost(tx2));
      const gasSpent = { player1: gas1, player2: 0n, owner: 0n };

      const raw = diffBalances(before, after);
      const gameResult: Balances = {
        player1: raw.player1 + gas1,
        player2: raw.player2,
        owner:   raw.owner,
      };

      printTable("cancelGame — full refund after 128 blocks", before, after, gasSpent, gameResult);

      expect(gameResult.player1).to.equal(0n);  // BET refunded, no net loss
      expect(gameResult.player2).to.equal(0n);
      expect(gameResult.owner).to.equal(0n);
    });

    it("closeGame — player1 fails to reveal, player2 closes after 256 blocks", async () => {
      const before = await snapBalances(player1, player2, owner);

      const tx1 = await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      const tx2 = await rps.connect(player2).joinGame(0, Move.Scissors, { value: BET });
      await mine(256);
      const tx3 = await rps.connect(player2).closeGame(0);

      const after = await snapBalances(player1, player2, owner);

      const gas1 = await gasCost(tx1);                           // player1: create only
      const gas2 = (await gasCost(tx2)) + (await gasCost(tx3)); // player2: join + close
      const gasSpent = { player1: gas1, player2: gas2, owner: 0n };

      const raw = diffBalances(before, after);
      const gameResult: Balances = {
        player1: raw.player1 + gas1,
        player2: raw.player2 + gas2,
        owner:   raw.owner,
      };

      printTable("closeGame — player1 loses BET for not revealing", before, after, gasSpent, gameResult);

      // closeGame pays the full pot to player2
      expect(gameResult.player1).to.equal(-BET);  // player1 loses their bet
      expect(gameResult.player2).to.equal(BET);   // player2 gains BET
      expect(gameResult.owner).to.equal(0n);
    });
  });
});

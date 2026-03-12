import { expect } from "chai";
import { ethers } from "hardhat";
import { RockPaperScissors } from "../typechain-types";

const Move = { None: 0, Rock: 1, Paper: 2, Scissors: 3 } as const;
type MoveValue = (typeof Move)[keyof typeof Move];

const BET = ethers.parseEther("0.0005");
const SALT = ethers.id("secret-salt");

function buildCommit(move: MoveValue, salt: string): string {
  return ethers.keccak256(
    ethers.solidityPacked(["uint8", "bytes32"], [move, salt])
  );
}

describe("RockPaperScissors", () => {
  let rps: RockPaperScissors;
  let owner: any, player1: any, player2: any, other: any;

  beforeEach(async () => {
    [owner, player1, player2, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("RockPaperScissors");
    rps = await Factory.connect(owner).deploy();
  });

  // ── stałe ──────────────────────────────────────────────────────────────────
  describe("constants", () => {
    it("BET = 0.0005 ETH", async () => {
      expect(await rps.BET()).to.equal(BET);
    });
    it("FEE_BPS = 100 (1%)", async () => {
      expect(await rps.FEE_BPS()).to.equal(100);
    });
    it("owner = deployer", async () => {
      expect(await rps.owner()).to.equal(owner.address);
    });
  });

  // ── createGame ─────────────────────────────────────────────────────────────
  describe("createGame", () => {
    it("tworzy grę i emituje GameCreated", async () => {
      const commit = buildCommit(Move.Rock, SALT);
      await expect(rps.connect(player1).createGame(commit, { value: BET }))
        .to.emit(rps, "GameCreated")
        .withArgs(1, player1.address);
    });

    it("revert jeśli bet != 0.0005 ETH", async () => {
      const commit = buildCommit(Move.Rock, SALT);
      await expect(
        rps.connect(player1).createGame(commit, { value: BET / 2n })
      ).to.be.revertedWithCustomError(rps, "WrongBetAmount");
    });
  });

  // ── joinGame ───────────────────────────────────────────────────────────────
  describe("joinGame", () => {
    beforeEach(async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
    });

    it("gracz 2 dołącza poprawnie", async () => {
      await expect(rps.connect(player2).joinGame(1, Move.Scissors, { value: BET }))
        .to.emit(rps, "GameJoined")
        .withArgs(1, player2.address);
    });

    it("revert jeśli zły bet", async () => {
      await expect(
        rps.connect(player2).joinGame(1, Move.Rock, { value: BET + 1n })
      ).to.be.revertedWithCustomError(rps, "WrongBetAmount");
    });

    it("revert jeśli ruch = None", async () => {
      await expect(
        rps.connect(player2).joinGame(1, Move.None, { value: BET })
      ).to.be.revertedWithCustomError(rps, "InvalidMove");
    });

    it("revert drugiego dołączenia", async () => {
      await rps.connect(player2).joinGame(1, Move.Rock, { value: BET });
      await expect(
        rps.connect(other).joinGame(1, Move.Paper, { value: BET })
      ).to.be.revertedWithCustomError(rps, "InvalidGameState");
    });
  });

  // ── reveal + wyniki ────────────────────────────────────────────────────────
  describe("reveal", () => {
    async function setupGame(move1: MoveValue, move2: MoveValue) {
      await rps.connect(player1).createGame(buildCommit(move1, SALT), { value: BET });
      await rps.connect(player2).joinGame(1, move2, { value: BET });
    }

    it("gracz 1 wygrywa: Rock beats Scissors", async () => {
      await setupGame(Move.Rock, Move.Scissors);
      const fee = (BET * 2n * 100n) / 10_000n;
      const prize = BET * 2n - fee;
      await expect(rps.connect(player1).reveal(1, Move.Rock, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(1, player1.address, prize);
    });

    it("gracz 2 wygrywa: Scissors beats Paper", async () => {
      await setupGame(Move.Paper, Move.Scissors);
      const fee = (BET * 2n * 100n) / 10_000n;
      const prize = BET * 2n - fee;
      await expect(rps.connect(player1).reveal(1, Move.Paper, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(1, player2.address, prize);
    });

    it("remis — zwrot pełny, brak fee w evencie", async () => {
      await setupGame(Move.Rock, Move.Rock);
      await expect(rps.connect(player1).reveal(1, Move.Rock, SALT))
        .to.emit(rps, "GameFinished")
        .withArgs(1, ethers.ZeroAddress, 0);
    });

    it("revert przy złym salt", async () => {
      await setupGame(Move.Rock, Move.Scissors);
      await expect(
        rps.connect(player1).reveal(1, Move.Rock, ethers.id("wrong"))
      ).to.be.revertedWithCustomError(rps, "InvalidCommit");
    });

    it("revert jeśli nie gracz 1", async () => {
      await setupGame(Move.Rock, Move.Scissors);
      await expect(
        rps.connect(other).reveal(1, Move.Rock, SALT)
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });
  });

  // ── claimNoOpponent ────────────────────────────────────────────────────────
  describe("claimNoOpponent", () => {
    beforeEach(async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
    });

    it("gracz 1 odbiera zwrot gdy nikt nie dołączył", async () => {
      await expect(rps.connect(player1).claimNoOpponent(1))
        .to.emit(rps, "GameFinished")
        .withArgs(1, player1.address, BET);
    });

    it("revert jeśli ktoś inny próbuje odebrać", async () => {
      await expect(
        rps.connect(other).claimNoOpponent(1)
      ).to.be.revertedWithCustomError(rps, "NotPlayer");
    });

    it("revert jeśli gra już ma gracza 2 (Committed)", async () => {
      await rps.connect(player2).joinGame(1, Move.Rock, { value: BET });
      await expect(
        rps.connect(player1).claimNoOpponent(1)
      ).to.be.revertedWithCustomError(rps, "InvalidGameState");
    });
  });

  // ── ETH balances ───────────────────────────────────────────────────────────
  describe("ETH balances", () => {
    const fee = (BET * 2n * 100n) / 10_000n;   // 1% z puli
    const prize = BET * 2n - fee;

    it("zwycięzca dostaje 99% puli, owner 1%", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(1, Move.Scissors, { value: BET });

      const revealTx = rps.connect(player1).reveal(1, Move.Rock, SALT);
      await expect(revealTx).to.changeEtherBalances(
        [player1, owner],
        [prize, fee],
        { includeFee: false }
      );
    });

    it("remis — obaj gracze dostają pełny zwrot, owner 0", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await rps.connect(player2).joinGame(1, Move.Rock, { value: BET });

      const revealTx = rps.connect(player1).reveal(1, Move.Rock, SALT);
      await expect(revealTx).to.changeEtherBalances(
        [player1, player2, owner],
        [BET, BET, 0n],
        { includeFee: false }
      );
    });

    it("claimNoOpponent — gracz 1 dostaje pełny zwrot", async () => {
      await rps.connect(player1).createGame(buildCommit(Move.Rock, SALT), { value: BET });
      await expect(rps.connect(player1).claimNoOpponent(1)).to.changeEtherBalance(
        player1,
        BET,
        { includeFee: false }
      );
    });
  });
});

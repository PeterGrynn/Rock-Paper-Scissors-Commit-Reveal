import { ethers } from "hardhat";

async function main() {
  const wallet = ethers.Wallet.createRandom();

  console.log("=== NEW WALLET ===");
  console.log(`Address:     ${wallet.address}`);
  console.log(`Private key: ${wallet.privateKey}`);
  console.log("\nWstaw do .env:");
  console.log(`PRIVATE_KEY=${wallet.privateKey}`);
  console.log("\n⚠️  Zapisz klucz prywatny w bezpiecznym miejscu!");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

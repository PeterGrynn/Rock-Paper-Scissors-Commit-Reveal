import { ethers, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying to [${network.name}] with account: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  const Factory = await ethers.getContractFactory("RockPaperScissors");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`RockPaperScissors deployed to: ${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

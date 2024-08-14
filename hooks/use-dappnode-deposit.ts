import { useCallback, useState } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import CONTRACTS, { ContractNetwork } from "@/utils/contracts";
import dappnodeIncentiveABI from "@/utils/abis/dappnodeIncentive";
import { loadCachedDeposits } from "@/utils/deposit";
import { getPublicClient } from "wagmi/actions";
import { config } from "@/wagmi";
import { fetchDeposit } from "@/utils/fetchEvents";

export type DepositDataJson = {
  pubkey: string;
  withdrawal_credentials: string;
  amount: bigint;
  signature: string;
  deposit_message_root: string;
  deposit_data_root: string;
  fork_version: string;
};

export type DappnodeUser = [
  safe: string,
  status: number,
  expectedDepositCount: number, // uint16
  totalStakeAmount: bigint // uint256
];

function useDappnodeDeposit(contractConfig: ContractNetwork | undefined, address: `0x${string}` | undefined, chainId: number) {
  const [deposits, setDeposits] = useState<DepositDataJson[]>([]);
  const [hasDuplicates, setHasDuplicates] = useState(false);
  const [isBatch, setIsBatch] = useState(false);
  const [filename, setFilename] = useState("");
  const client = getPublicClient(config, { chainId: chainId as 100 });

  const { data: user }: { data: DappnodeUser | undefined } = useReadContract({
    abi: dappnodeIncentiveABI,
    address: contractConfig?.addresses.dappnodeIncentive,
    functionName: "users",
    args: [address],
  });

  const isWrongNetwork = chainId !== 100;
  const { data: depositHash, writeContractAsync, isPending, isError } = useWriteContract();
  const { isSuccess: depositSuccess } = useWaitForTransactionReceipt({
    hash: depositHash,
  });

  const dappnodeValidate = useCallback(
    async (deposits: DepositDataJson[]) => {
      let newDeposits = [];
      let hasDuplicates = false;
      let _isBatch = false;
      if (contractConfig && user) {
        const checkJsonStructure = (depositDataJson: DepositDataJson) => {
          return (
            depositDataJson.pubkey &&
            depositDataJson.withdrawal_credentials &&
            depositDataJson.amount &&
            depositDataJson.signature &&
            depositDataJson.deposit_message_root &&
            depositDataJson.deposit_data_root &&
            depositDataJson.fork_version
          );
        };

        if (!deposits.every) {
          throw Error(
            "Oops, something went wrong while parsing your json file. Please check the file and try again."
          );
        }

        if (
          deposits.length === 0 ||
          !deposits.every((d) => checkJsonStructure(d))
        ) {
          throw Error("This is not a valid file. Please try again.");
        }

        if (
          !deposits.every((d) => d.fork_version === contractConfig.forkVersion)
        ) {
          throw Error(
            "This JSON file isn't for the right network (" +
              deposits[0].fork_version +
              "). Upload a file generated for you current network: " +
              chainId
          );
        }
                
        if (!deposits.every((d) => `0x`+d.withdrawal_credentials.substring(24).toLocaleLowerCase() === user[0].toLowerCase())) {
          throw Error(
            "Atleast one of the provided keys does not match your safe address as withdrawal credentials."
          );
        }
        if (deposits.length !== user[2]) {
          throw Error(
            `Wrong number of keys. Expected claiming (${user[2]}) validator deposits to your safe.`
          );
        }

        const { deposits: existingDeposits, lastBlock: fromBlock } =
          await loadCachedDeposits(
            chainId,
            contractConfig.depositStartBlockNumber
          );

        const events = await fetchDeposit(
          contractConfig.addresses.deposit,
          fromBlock,
          client
        );

        let pks = events.map((e) => e.args.pubkey);
        pks = pks.concat(existingDeposits);
        console.log(pks);
        console.log(`Found ${pks.length} existing deposits`);

        for (const deposit of deposits) {
          if (!pks.includes(`0x${deposit.pubkey}`)) {
            console.log("new deposit", deposit.pubkey);
            newDeposits.push(deposit);
          }
        }
        hasDuplicates = newDeposits.length !== deposits.length;

        if (newDeposits.length === 0) {
          throw Error(
            "Deposits have already been made to all validators in this file."
          );
        }

        const wc = newDeposits[0].withdrawal_credentials;

        // batch processing necessary for both single deposit and batch deposit for same withdrawal_credentials
        _isBatch = newDeposits.every((d) => d.withdrawal_credentials === wc);

        // check if withdrawal credential start with 0x00
        _isBatch = !wc.startsWith("00");

        if (_isBatch && newDeposits.length > 128) {
          throw Error(
            "Number of validators exceeds the maximum batch size of 128. Please upload a file with 128 or fewer validators."
          );
        }

        if (
          !newDeposits.every((d) => BigInt(d.amount) === BigInt(32000000000))
        ) {
          throw Error("Amount should be exactly 32 tokens for deposits.");
        }

        const pubKeys = newDeposits.map((d) => d.pubkey);
        if (
          pubKeys.some((pubkey, index) => pubKeys.indexOf(pubkey) !== index)
        ) {
          throw Error("Duplicated public keys.");
        }
      }

      return { deposits: newDeposits, hasDuplicates, _isBatch };
    },
    [address, contractConfig, deposits, user]
  );

  const setDappnodeDepositData = useCallback(
    async (fileData: string, filename: string) => {
      setFilename(filename);
      if (fileData) {
        let data: DepositDataJson[] = [];
        try {
          data = JSON.parse(fileData);
        } catch (error) {
          throw Error(
            "Oops, something went wrong while parsing your json file. Please check the file and try again."
          );
        }
        const { deposits, hasDuplicates, _isBatch } = await dappnodeValidate(
          data
        );
        setDeposits(deposits);
        setHasDuplicates(hasDuplicates);
        setIsBatch(_isBatch);
      } else {
        setDeposits([]);
        setHasDuplicates(false);
        setIsBatch(false);
      }
    },
    [dappnodeValidate]
  );

  const dappnodeDeposit = useCallback(async () => {
    if (contractConfig) {
      try {
        let data:{
            pubkeys: string
            signatures: string
            deposit_data_roots: string[]
        } = {pubkeys:'',signatures:'',deposit_data_roots:[]};

        deposits.forEach((deposit, i) => {
          if (i === 0) {
            data.pubkeys += deposit.pubkey.startsWith('0x') ? deposit.pubkey : `0x${deposit.pubkey}`;
            data.signatures += deposit.signature.startsWith('0x') ? deposit.signature : `0x${deposit.signature}`;
          } else {
            data.pubkeys += deposit.pubkey.startsWith('0x') ? deposit.pubkey.slice(2) : deposit.pubkey;
            data.signatures += deposit.signature.startsWith('0x') ? deposit.signature.slice(2) : deposit.signature;
          }
          
          data.deposit_data_roots.push(deposit.deposit_data_root.startsWith('0x') ? deposit.deposit_data_root : `0x${deposit.deposit_data_root}`);
        });

        contractConfig.addresses.dappnodeIncentive &&
        await  writeContractAsync({
            abi: dappnodeIncentiveABI,
            address: contractConfig.addresses.dappnodeIncentive,
            functionName: "submitPendingDeposits",
            args: [data.pubkeys, data.signatures, data.deposit_data_roots],
          });
      } catch (err) {
        console.error(err);
      }
    }
  }, [address, deposits]);

  return {
    depositSuccess,
    depositHash,
    depositData: { deposits, filename, hasDuplicates, isBatch },
    user,
    setDappnodeDepositData,
    dappnodeDeposit,
    isWrongNetwork,
    claimStatusPending: isPending,
    claimStatusError: isError,
  };
}

export default useDappnodeDeposit;

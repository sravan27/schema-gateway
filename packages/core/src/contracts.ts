import { parseAbiItem } from "viem";

export const purchaseEventAbiItem = parseAbiItem(
  "event Purchase(address indexed buyer, address indexed token, uint256 amount, uint256 credits, bytes32 indexed keyCommitment)"
);

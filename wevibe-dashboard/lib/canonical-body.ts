export function buildRelayCanonicalBody(
  orgId: string,
  walletAddress: string,
  txBytesBase64: string
): string {
  return (
    "WV-RELAY-v1\n" +
    "org_id:" + orgId + "\n" +
    "wallet_address:" + walletAddress + "\n" +
    "tx_bytes_base64:" + txBytesBase64 + "\n"
  );
}
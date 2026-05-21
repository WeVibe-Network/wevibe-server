export type { MemberRecord, CreditBalance, TopUpRequest, TopUpResponse, Transaction } from './hub-client';

export interface WalletInfo {
  provider: 'keplr' | 'leap';
  address: string;
  linked: boolean;
}

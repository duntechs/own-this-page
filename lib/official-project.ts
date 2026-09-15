// Fixed site identity. These are not advertiser slots or user-editable metadata.
export const officialProject = Object.freeze({
  name: 'Own This Page',
  symbol: 'PAGE',
  // Set only when the project owner supplies a new CA. Never infer from a wallet.
  coinAddress: '' as string,
  xUrl: 'https://x.com/ownthispage',
  xHandle: '@ownthispage',
  explorer: 'https://solscan.io',
});

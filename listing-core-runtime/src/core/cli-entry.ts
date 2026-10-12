// The slice of the shared listing core the CLI runs. Bundled with esbuild at
// run time (cli/lib/core-loader.mjs) with the same `@` alias the extension uses,
// so the CLI and the extension execute identical listing/trademark logic.

export { runListingPipeline } from './pipeline/runListingPipeline';
export {
  setTrademarkApiBase,
  checkForTrademarks,
  getActionableMatches,
  screenTermsForTrademarks,
  TRADEMARK_JURISDICTIONS,
} from './listing/trademarkCheck';
export { DEFAULT_LISTING_CONFIG } from './types';
export { banTrademark, unbanWord, banTermFor, hasBannedWord } from './listing/bannedWords';
export { amazonAutosuggest } from './validation/amazonAutosuggest';

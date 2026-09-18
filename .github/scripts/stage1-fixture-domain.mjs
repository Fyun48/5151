// Stage 1 fixture CLI. Never writes feature flags.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const spec = process.env.STAGE1_DOMAIN_DB_MODULE || "/app/src/db.js";
  const href = spec.startsWith("file:") ? spec : pathToFileURL(path.resolve(spec)).href;
  const root = process.env.STAGE1_FIXTURE_SRC_ROOT || "/app/src";
  const toHref = (file) => pathToFileURL(path.resolve(root, file)).href;
  const [dbMod, memberMod, listingMod, demandMod, matchMod, opsMod] = await Promise.all([
    import(href),
    import(toHref("members.js")),
    import(toHref("selfListings.js")),
    import(toHref("demand.js")),
    import(toHref("rentalMatch.js")),
    import(toHref("stage1FixtureOps.js")),
  ]);
  const flags = dbMod.getRentalMarketplaceFlags();
  demandMod.setRentalMarketplaceFlags(flags);
  if (typeof dbMod.getRentalCatalog === "function") {
    const catalog = dbMod.getRentalCatalog();
    demandMod.setRentalCatalogCache(catalog);
    listingMod.setSelfListingCatalog(catalog, flags);
  }
  opsMod.runStage1FixtureDomain({
    db: dbMod.db,
    getRentalMarketplaceFlags: dbMod.getRentalMarketplaceFlags,
    mode: process.env.STAGE1_FIXTURE_MODE || "verify",
    runId: process.env.STAGE1_FIXTURE_RUN_ID || "",
    resultPath: process.env.STAGE1_FIXTURE_RESULT_PATH || "/tmp/stage1-fixture-result.json",
    deps: {
      workflowRunId: process.env.GITHUB_RUN_ID || "local",
      registerUser: memberMod.registerUser,
      deleteUser: memberMod.deleteUser,
      createSelfListing: listingMod.createSelfListing,
      closeSelfListing: listingMod.closeSelfListing,
      getSelfListing: listingMod.getSelfListing,
      createDemandPost: demandMod.createDemandPost,
      applyWishLifecycleAction: demandMod.applyWishLifecycleAction,
      listDemandPosts: demandMod.listDemandPosts,
      getDemandPost: demandMod.getDemandPost,
      evaluateCounterfactualMatch: matchMod.evaluateCounterfactualMatch,
      isCounterfactuallyMatchable: matchMod.isCounterfactuallyMatchable,
    },
  });
  console.log("STAGE1_FIXTURE_DOMAIN_OK");
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  await main();
}

import { loadPraHelpers } from "./loadPraHelpers.js";

const PraHelpers = loadPraHelpers();

export const WISH_BULK_SECTION_SELECTOR = PraHelpers.WISH_BULK_SECTION_SELECTOR;
export const findWishBulkSection = PraHelpers.findWishBulkSection;
export const nextWishBulkStates = PraHelpers.nextWishBulkStates;
export const wishBulkConditionRowsFromSection = PraHelpers.wishBulkConditionRowsFromSection;
export const applyWishBulkToSection = PraHelpers.applyWishBulkToSection;

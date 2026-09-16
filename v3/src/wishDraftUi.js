import { loadPraHelpers } from "./loadPraHelpers.js";

const PraHelpers = loadPraHelpers();

export const isWishDraftContext = PraHelpers.isWishDraftContext;
export const planWishDraftSave = PraHelpers.planWishDraftSave;
export const planWishPublish = PraHelpers.planWishPublish;
export const wishCreateButtonLabel = PraHelpers.wishCreateButtonLabel;
export const beginWishFormMutation = PraHelpers.beginWishFormMutation;
export const endWishFormMutation = PraHelpers.endWishFormMutation;

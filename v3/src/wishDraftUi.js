export function isWishDraftContext({ editingId = 0, activeId = 0, fullReconfirm = false } = {}) {
  if (fullReconfirm) return false;
  if (activeId && Number(editingId) === Number(activeId)) return false;
  return true;
}

export function planWishDraftSave({ editingId = 0, activeId = 0, fullReconfirm = false } = {}) {
  if (!isWishDraftContext({ editingId, activeId, fullReconfirm })) {
    return { allowed: false, reason: activeId && Number(editingId) === Number(activeId) ? "active_edit" : "active_reconfirm" };
  }
  const id = Number(editingId) || 0;
  if (id) {
    return {
      allowed: true,
      method: "PATCH",
      url: `/api/wish-rooms/${id}`,
      body: { draft: true },
      publish: false,
    };
  }
  return {
    allowed: true,
    method: "POST",
    url: "/api/wish-rooms",
    body: { draft: true },
    publish: false,
  };
}

export function planWishPublish({ editingId = 0, activeId = 0 } = {}) {
  const id = Number(editingId) || 0;
  if (id && activeId && Number(id) === Number(activeId)) {
    return { method: "PATCH", publish: false, create: false };
  }
  if (id) {
    return { method: "PATCH", publish: true, create: false };
  }
  return { method: "POST", publish: false, create: true, draft: false };
}

export function wishCreateButtonLabel({ active = null, draft = null } = {}) {
  if (!active && draft) return "繼續編輯草稿";
  return "建立我的許願房";
}

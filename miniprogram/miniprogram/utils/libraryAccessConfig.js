const LIBRARY_ACCESS_MODE = Object.freeze({
  PROFILE: "profile",
  OPENID: "openid",
});

const LIBRARY_ACCESS_FLAGS = Object.freeze({
  favoritesIdentityMode: LIBRARY_ACCESS_MODE.PROFILE,
  historyIdentityMode: LIBRARY_ACCESS_MODE.PROFILE,
});

const FLAG_KEY_BY_KIND = Object.freeze({
  favorites: "favoritesIdentityMode",
  history: "historyIdentityMode",
});

function getLibraryAccessMode(kind, flags = LIBRARY_ACCESS_FLAGS) {
  const flagKey = FLAG_KEY_BY_KIND[kind];
  if (!flagKey) {
    throw new RangeError(`不支持的用户列表类型：${kind || ""}`);
  }
  return flags && flags[flagKey] === LIBRARY_ACCESS_MODE.OPENID
    ? LIBRARY_ACCESS_MODE.OPENID
    : LIBRARY_ACCESS_MODE.PROFILE;
}

module.exports = {
  LIBRARY_ACCESS_FLAGS,
  LIBRARY_ACCESS_MODE,
  getLibraryAccessMode,
};

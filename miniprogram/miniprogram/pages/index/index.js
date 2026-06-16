const {
  DEFAULT_FILTERS,
  filterCases,
  selectedFilterCount,
} = require("../../utils/caseData");
const {
  fetchVisibleCases,
  fetchVisibleBanners,
} = require("../../utils/cloudData");

function createFilters() {
  return DEFAULT_FILTERS.map((filter, index) => ({
    ...filter,
    isExpanded: index === 0,
    selectedValues: [],
    optionItems: filter.options.map((value) => ({
      value,
      selected: false,
    })),
  }));
}

function syncOptionItems(filter) {
  return {
    ...filter,
    optionItems: filter.options.map((value) => ({
      value,
      selected: filter.selectedValues.includes(value),
    })),
  };
}

function buildSelectedFilters(filters) {
  return filters.reduce((selected, filter) => {
    if (filter.selectedValues.length) {
      selected[filter.key] = filter.selectedValues;
    }
    return selected;
  }, {});
}

function buildSelectedPills(filters) {
  return filters.reduce((pills, filter) => {
    filter.selectedValues.forEach((value) => {
      pills.push({
        id: `${filter.key}:${value}`,
        key: filter.key,
        value,
        title: filter.title,
      });
    });
    return pills;
  }, []);
}

Page({
  data: {
    loading: true,
    errorMessage: "",
    query: "",
    allCases: [],
    filteredCases: [],
    banners: [],
    filters: createFilters(),
    selectedPills: [],
    selectedCount: 0,
  },

  onLoad() {
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({
      loading: true,
      errorMessage: "",
    });

    try {
      const cases = await fetchVisibleCases();
      const banners = await fetchVisibleBanners(cases);
      this.setData({
        allCases: cases,
        banners,
        loading: false,
      });
      this.applyFilters();
    } catch (error) {
      console.error("案例数据读取失败", error);
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到案例数据，请检查云环境和数据库权限。",
      });
    }
  },

  applyFilters() {
    const selectedFilters = buildSelectedFilters(this.data.filters);
    const filteredCases = filterCases(this.data.allCases, {
      query: this.data.query,
      selectedFilters,
    });

    this.setData({
      filteredCases,
      selectedPills: buildSelectedPills(this.data.filters),
      selectedCount: selectedFilterCount(selectedFilters),
    });
  },

  onSearchInput(event) {
    this.setData({
      query: event.detail.value,
    });
    this.applyFilters();
  },

  toggleFilterGroup(event) {
    const key = event.currentTarget.dataset.key;
    const filters = this.data.filters.map((filter) => ({
      ...filter,
      isExpanded: filter.key === key ? !filter.isExpanded : filter.isExpanded,
    }));
    this.setData({ filters });
  },

  toggleFilterOption(event) {
    const { key, value } = event.currentTarget.dataset;
    const filters = this.data.filters.map((filter) => {
      if (filter.key !== key) return filter;

      const exists = filter.selectedValues.includes(value);
      const selectedValues =
        filter.type === "single"
          ? exists
            ? []
            : [value]
          : exists
            ? filter.selectedValues.filter((item) => item !== value)
            : [...filter.selectedValues, value];

      return syncOptionItems({
        ...filter,
        selectedValues,
      });
    });

    this.setData({ filters });
    this.applyFilters();
  },

  removeSelectedPill(event) {
    const { key, value } = event.currentTarget.dataset;
    const filters = this.data.filters.map((filter) => {
      if (filter.key !== key) return filter;
      return syncOptionItems({
        ...filter,
        selectedValues: filter.selectedValues.filter((item) => item !== value),
      });
    });
    this.setData({ filters });
    this.applyFilters();
  },

  clearFilters() {
    this.setData({
      query: "",
      filters: createFilters(),
    });
    this.applyFilters();
  },

  navigateToCase(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },

  onBannerTap(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },
});

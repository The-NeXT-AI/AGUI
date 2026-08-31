import { productConfig } from "@/product/product-config";

export const MINIMUM_MAIN_WIDTH = productConfig.layout.minimumMainWidth;

const SASH_ALLOWANCE = 6;

export function panesNeedMutualExclusion(
  viewportWidth: number,
  sidebarWidth: number,
  detailPanelWidth: number,
  minimumMainWidth = productConfig.layout.minimumMainWidth,
) {
  return viewportWidth < sidebarWidth + detailPanelWidth + minimumMainWidth + SASH_ALLOWANCE;
}

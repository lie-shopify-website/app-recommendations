/**
 * 结账扩展：从 Search & Discovery 标准元字段读取「互补产品」
 * - namespace: shopify--discovery--product_recommendation
 * - key: complementary_products（类型一般为 list.product_reference，值为 Product GID 的 JSON 数组）
 * - 加购：applyCartLinesChange
 *
 * 需在后台为对应 metafield 开启 Storefront 可见性（标准定义通常已可用）。
 */

// @ts-check
/** @type {Record<string, number>} */
import COMPLEMENTARY_MANUAL_WEIGHT_OVERRIDES from "./complementary-weight-overrides.json";

export { COMPLEMENTARY_MANUAL_WEIGHT_OVERRIDES };

/**
 * 解析商户在结账扩展设置里粘贴的 JSON 字符串，得到「Product GID → 权重」。
 * 非法 JSON 或非对象时返回空对象；仅保留键含 `Product` 且值为有限数字的项。
 *
 * @param {unknown} text
 * @returns {Record<string, number>}
 */
export function parseWeightOverridesJson(text) {
  if (text == null || text === "") return {};
  const raw = typeof text === "string" ? text : String(text);
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== "string" || !k.includes("Product")) continue;
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      out[k] = num;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 设为 `true` 时输出调试日志（含权重合并）。上线前请改回 `false`。
 */
export const ENABLE_RECOMMENDATION_DEBUG = false;

/** Shopify Search & Discovery 互补推荐标准元字段 */
export const DISCOVERY_COMPLEMENTARY_NAMESPACE = "shopify--discovery--product_recommendation";
export const DISCOVERY_COMPLEMENTARY_KEY = "complementary_products";

/** 读取单件商品的 complementary_products 元字段（只要 type + value） */
export const PRODUCT_COMPLEMENTARY_METAFIELD_QUERY = `#graphql
  query ProductComplementaryMetafield($id: ID!) {
    product(id: $id) {
      id
      complementary: metafield(
        namespace: "shopify--discovery--product_recommendation"
        key: "complementary_products"
      ) {
        type
        value
      }
    }
  }
`;

/** 根据合并后的 Product GID 列表批量取展示字段 */
export const PRODUCT_NODES_QUERY = `#graphql
  query ComplementaryProductNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        featuredImage {
          url
          altText
        }
        variants(first: 50) {
          nodes {
            id
            title
            availableForSale
            selectedOptions {
              name
              value
            }
            price {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

/** 按购物车行顺序去重后的商品 ID（A、B 各算一次） */
export function getOrderedUniqueProductIds(lines) {
  const ids = [];
  const seen = new Set();
  for (const line of lines) {
    if (line.merchandise?.type !== "variant") continue;
    const pid = line.merchandise.product.id;
    if (!seen.has(pid)) {
      seen.add(pid);
      ids.push(pid);
    }
  }
  return ids;
}

/**
 * 解析 complementary_products 的 value（JSON 数组字符串）为 Product GID 列表
 */
export function parseComplementaryProductGids(metafield) {
  if (!metafield?.value) return [];
  try {
    const parsed = JSON.parse(metafield.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x) => typeof x === "string" && x.includes("Product"),
    );
  } catch {
    return [];
  }
}

export function complementaryGidsFromProductData(data) {
  const mf = data?.product?.complementary;
  return parseComplementaryProductGids(mf);
}

/**
 * 单个锚点互补列表内：第 1 个权重最高，依次减 1，不低于下限。
 * 例：第 1 个 10、第 2 个 9 …（与需求「C:10/D:9/E:8/F:7」一致）
 */
export const COMPLEMENTARY_WEIGHT_START = 10;
export const COMPLEMENTARY_WEIGHT_FLOOR = 1;

export function weightForComplementaryListIndex(index) {
  return Math.max(
    COMPLEMENTARY_WEIGHT_FLOOR,
    COMPLEMENTARY_WEIGHT_START - index,
  );
}

/**
 * 多锚点互补列表：同商品在多锚点出现则**位次权重相加**；再与 JSON 配置中的保底权重取 **max**；
 * 最后按最终权重**从大到小**排序；同权重时先按「全局先出现」的先后（锚点顺序 + 列表内顺序），
 * 展示顺序在拉到价格后还会再按「同权重价高优先」微调（见 {@link orderCardsByGidOrderThenPrice}）。
 *
 * @param {string[][]} gidListsPerAnchor 与购物车锚点顺序一致，每项为该商品的互补 Product GID 数组（有序）
 * @param {Record<string, number>} [manualOverrides] 默认用 `complementary-weight-overrides.json` 合并进来的对象
 * @returns {Array<{ gid: string; sum: number; finalWeight: number; tieOrder: number }>}
 */
export function mergeComplementaryGidsByWeightRows(
  gidListsPerAnchor,
  manualOverrides = COMPLEMENTARY_MANUAL_WEIGHT_OVERRIDES,
) {
  const overrides =
    manualOverrides && typeof manualOverrides === "object"
      ? manualOverrides
      : {};

  /** @type {Map<string, { sum: number; tieOrder: number }>} */
  const agg = new Map();
  let tieCounter = 0;

  for (const list of gidListsPerAnchor) {
    if (!Array.isArray(list)) continue;
    list.forEach((gid, index) => {
      if (!gid || typeof gid !== "string") return;
      const w = weightForComplementaryListIndex(index);
      const cur = agg.get(gid);
      if (cur) {
        cur.sum += w;
      } else {
        agg.set(gid, { sum: w, tieOrder: tieCounter++ });
      }
    });
  }

  const rows = [];
  for (const [gid, { sum, tieOrder }] of agg) {
    const raw = overrides[gid];
    const num =
      raw !== undefined && raw !== null ? Number(raw) : Number.NaN;
    const finalWeight =
      !Number.isNaN(num) ? Math.max(sum, num) : sum;
    rows.push({ gid, sum, finalWeight, tieOrder });
  }

  for (const [gid, raw] of Object.entries(overrides)) {
    if (!gid.includes("Product")) continue;
    if (agg.has(gid)) continue;
    const num = Number(raw);
    if (Number.isNaN(num)) continue;
    rows.push({
      gid,
      sum: 0,
      finalWeight: num,
      tieOrder: -1,
    });
  }

  rows.sort((a, b) => {
    if (b.finalWeight !== a.finalWeight) return b.finalWeight - a.finalWeight;
    return a.tieOrder - b.tieOrder;
  });

  if (ENABLE_RECOMMENDATION_DEBUG) {
    console.log(
      "[product-recommendations]",
      "互补权重合并结果（排除购物车前）",
      rows.map((r) => ({
        gid: r.gid,
        sumFromLists: r.sum,
        finalWeight: r.finalWeight,
      })),
    );
  }

  return rows;
}

/**
 * @param {string[][]} gidListsPerAnchor
 * @param {Record<string, number>} [manualOverrides]
 * @returns {string[]} 排序后的 Product GID（尚未排除购物车）
 */
export function mergeComplementaryGidsByWeight(
  gidListsPerAnchor,
  manualOverrides = COMPLEMENTARY_MANUAL_WEIGHT_OVERRIDES,
) {
  return mergeComplementaryGidsByWeightRows(
    gidListsPerAnchor,
    manualOverrides,
  ).map((r) => r.gid);
}

function variantOptionLabel(variantNode) {
  const opts = variantNode?.selectedOptions;
  if (opts?.length) {
    return opts.map((o) => o.value).join(" · ");
  }
  const t = variantNode?.title;
  if (t && t !== "Default Title") return t;
  return "";
}

export function productNodeToRecommendationCard(node) {
  if (!node?.id) return null;
  const raw = node.variants?.nodes ?? [];
  const available = raw.filter((v) => v?.availableForSale && v?.id);
  if (available.length === 0) return null;

  const variants = available.map((v) => ({
    variantId: v.id,
    label: variantOptionLabel(v) || "—",
    priceAmount: Number(v.price?.amount ?? 0),
    currencyCode: v.price?.currencyCode ?? "USD",
  }));

  const first = variants[0];
  return {
    productId: node.id,
    title: node.title ?? "",
    imageUrl: node.featuredImage?.url,
    imageAlt: node.featuredImage?.altText ?? node.title ?? "",
    variants,
    variantId: first.variantId,
    priceAmount: first.priceAmount,
    currencyCode: first.currencyCode,
  };
}

export function normalizeNodesToRecommendationCards(data) {
  const nodes = data?.nodes ?? [];
  return nodes
    .map((n) => productNodeToRecommendationCard(n))
    .filter(Boolean);
}

/** 按合并后的 GID 顺序排列卡片（nodes 返回顺序不一定与 ids 一致） */
export function orderCardsByGidOrder(cards, orderedGids) {
  const map = new Map(cards.map((c) => [c.productId, c]));
  return orderedGids.map((gid) => map.get(gid)).filter(Boolean);
}

/**
 * 取卡片用于排序的「展示价」：多变体时取**最高**变体价（同权重时价高排前）。
 *
 * @param {{ variants?: Array<{ priceAmount?: number }>; priceAmount?: number }} card
 */
export function maxDisplayPriceAmount(card) {
  const vs = card?.variants;
  if (vs?.length) {
    return Math.max(
      0,
      ...vs.map((v) => Number(v?.priceAmount ?? 0)),
    );
  }
  return Number(card?.priceAmount ?? 0);
}

/**
 * 先按 `orderedGids` 对齐节点结果，再排序：**最终权重大者优先**；同权重则**价高者优先**；
 * 仍相同则保持 `orderedGids` 中的相对顺序。
 *
 * @param {Array<{ productId: string; variants?: Array<{ priceAmount?: number }>; priceAmount?: number }>} cards
 * @param {string[]} orderedGids merge 后的 GID 顺序（含权重语义）
 * @param {Map<string, number>} weightByGid Product GID → finalWeight
 */
export function orderCardsByGidOrderThenPrice(cards, orderedGids, weightByGid) {
  const byGid = new Map(cards.map((c) => [c.productId, c]));
  const list = orderedGids
    .map((gid, index) => {
      const card = byGid.get(gid);
      if (!card) return null;
      const w = weightByGid.get(gid);
      const weight = typeof w === "number" && Number.isFinite(w) ? w : 0;
      return {
        card,
        index,
        weight,
        price: maxDisplayPriceAmount(card),
      };
    })
    .filter(Boolean);

  list.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.price !== a.price) return b.price - a.price;
    return a.index - b.index;
  });

  return list.map((x) => x.card);
}

/**
 * 结账推荐区块**最多展示几件商品**（横向列表最终截取）。
 * 需要改显示个数时，主要改这里即可。
 */
export const MAX_RECOMMENDATION_PRODUCTS_DISPLAY = 12;

/**
 * 单次从 Storefront 用 `nodes(ids)` 解析多少个 Product GID（互补推荐、兜底合并后的上限）。
 * 建议 ≥ {@link MAX_RECOMMENDATION_PRODUCTS_DISPLAY}，避免可展示候选被截断。
 */
export const MAX_COMPLEMENTARY_GIDS_TO_RESOLVE = 50;

/**
 * 兜底：互补推荐为空、或 nodes 解析后没有可售变体时，仍展示这些固定商品。
 * 请填入本店商品的 Product GID（Admin → 商品 → 地址栏 id 或 GraphQL），例如：
 * "gid://shopify/Product/8234567890123"
 * 留空数组表示不启用兜底，此时界面会走「暂无推荐」。
 */
// export const FALLBACK_PRODUCT_GIDS = [
//   'gid://shopify/Product/8526784954518',
//   'gid://shopify/Product/8526784921750',
// ];
export const FALLBACK_PRODUCT_GIDS = [];

export function getFallbackProductGidsExcludingCart(cartProductIdSet) {
  return FALLBACK_PRODUCT_GIDS.filter(
    (gid) => typeof gid === "string" && gid.length > 0 && !cartProductIdSet.has(gid),
  ).slice(0, MAX_COMPLEMENTARY_GIDS_TO_RESOLVE);
}

/** 结账编辑器预览用静态卡片（非真实商品 ID） */
export const EDITOR_PREVIEW_RECOMMENDATIONS = [
  {
    productId: "gid://shopify/Product/PREVIEW_1",
    title: "示例商品 A（多变体）",
    imageUrl: undefined,
    imageAlt: "示例 A",
    variants: [
      {
        variantId: "gid://shopify/ProductVariant/PREVIEW_1A",
        label: "小号 / 红",
        priceAmount: 19.99,
        currencyCode: "USD",
      },
      {
        variantId: "gid://shopify/ProductVariant/PREVIEW_1B",
        label: "大号 / 蓝",
        priceAmount: 22.5,
        currencyCode: "USD",
      },
    ],
    variantId: "gid://shopify/ProductVariant/PREVIEW_1A",
    priceAmount: 19.99,
    currencyCode: "USD",
  },
  {
    productId: "gid://shopify/Product/PREVIEW_2",
    title: "示例商品 B",
    imageUrl: undefined,
    imageAlt: "示例 B",
    variants: [
      {
        variantId: "gid://shopify/ProductVariant/PREVIEW_2",
        label: "默认",
        priceAmount: 24.5,
        currencyCode: "USD",
      },
    ],
    variantId: "gid://shopify/ProductVariant/PREVIEW_2",
    priceAmount: 24.5,
    currencyCode: "USD",
  },
  {
    productId: "gid://shopify/Product/PREVIEW_3",
    title: "示例商品 C",
    imageUrl: undefined,
    imageAlt: "示例 C",
    variants: [
      {
        variantId: "gid://shopify/ProductVariant/PREVIEW_3",
        label: "默认",
        priceAmount: 12.0,
        currencyCode: "USD",
      },
    ],
    variantId: "gid://shopify/ProductVariant/PREVIEW_3",
    priceAmount: 12.0,
    currencyCode: "USD",
  },
  {
    productId: "gid://shopify/Product/PREVIEW_4",
    title: "示例商品 D",
    imageUrl: undefined,
    imageAlt: "示例 D",
    variants: [
      {
        variantId: "gid://shopify/ProductVariant/PREVIEW_4",
        label: "默认",
        priceAmount: 33.0,
        currencyCode: "USD",
      },
    ],
    variantId: "gid://shopify/ProductVariant/PREVIEW_4",
    priceAmount: 33.0,
    currencyCode: "USD",
  },
];

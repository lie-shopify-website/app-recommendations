/**
 * 结账扩展：从 Search & Discovery 标准元字段读取「互补产品」
 * - namespace: shopify--discovery--product_recommendation
 * - key: complementary_products（类型一般为 list.product_reference，值为 Product GID 的 JSON 数组）
 * - 加购：applyCartLinesChange
 *
 * 需在后台为对应 metafield 开启 Storefront 可见性（标准定义通常已可用）。
 */

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
        variants(first: 1) {
          nodes {
            id
            availableForSale
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
 * 合并多份 GID 列表：先保留 A 的顺序，再追加 B 中未出现过的，以此类推（与 mergeRecommendationLists 逻辑一致）
 */
export function mergeGidLists(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const gid of list) {
      if (!gid || seen.has(gid)) continue;
      seen.add(gid);
      out.push(gid);
    }
  }
  return out;
}

export function productNodeToRecommendationCard(node) {
  if (!node?.id) return null;
  const variant = node.variants?.nodes?.[0];
  if (!variant?.availableForSale || !variant?.id) return null;
  return {
    productId: node.id,
    title: node.title ?? "",
    imageUrl: node.featuredImage?.url,
    imageAlt: node.featuredImage?.altText ?? node.title ?? "",
    variantId: variant.id,
    priceAmount: Number(variant.price?.amount ?? 0),
    currencyCode: variant.price?.currencyCode ?? "USD",
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

/** 单次拉取节点数量上限，避免请求过大 */
export const MAX_COMPLEMENTARY_GIDS_TO_RESOLVE = 50;

/**
 * 兜底：互补推荐为空、或 nodes 解析后没有可售变体时，仍展示这些固定商品。
 * 请填入本店商品的 Product GID（Admin → 商品 → 地址栏 id 或 GraphQL），例如：
 * "gid://shopify/Product/8234567890123"
 * 留空数组表示不启用兜底，此时界面会走「暂无推荐」。
 */
export const FALLBACK_PRODUCT_GIDS = [
  'gid://shopify/Product/8526784954518',
  'gid://shopify/Product/8526784921750',
];

export function getFallbackProductGidsExcludingCart(cartProductIdSet) {
  return FALLBACK_PRODUCT_GIDS.filter(
    (gid) => typeof gid === "string" && gid.length > 0 && !cartProductIdSet.has(gid),
  ).slice(0, MAX_COMPLEMENTARY_GIDS_TO_RESOLVE);
}

export const EXAMPLE_STATIC_RECOMMENDATIONS = [
  {
    productId: "gid://shopify/Product/EXAMPLE_1",
    title: "示例商品 A",
    imageUrl: undefined,
    imageAlt: "示例 A",
    variantId: "gid://shopify/ProductVariant/EXAMPLE_1",
    priceAmount: 19.99,
    currencyCode: "USD",
  },
  {
    productId: "gid://shopify/Product/EXAMPLE_2",
    title: "示例商品 B",
    imageUrl: undefined,
    imageAlt: "示例 B",
    variantId: "gid://shopify/ProductVariant/EXAMPLE_2",
    priceAmount: 24.5,
    currencyCode: "USD",
  },
  {
    productId: "gid://shopify/Product/EXAMPLE_3",
    title: "示例商品 C",
    imageUrl: undefined,
    imageAlt: "示例 C",
    variantId: "gid://shopify/ProductVariant/EXAMPLE_3",
    priceAmount: 12.0,
    currencyCode: "USD",
  },
  {
    productId: "gid://shopify/Product/EXAMPLE_4",
    title: "示例商品 D",
    imageUrl: undefined,
    imageAlt: "示例 D",
    variantId: "gid://shopify/ProductVariant/EXAMPLE_4",
    priceAmount: 33.0,
    currencyCode: "USD",
  },
];

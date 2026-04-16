import "@shopify/ui-extensions/preact";
import {
  useExtensionEditor,
  useSettings,
} from "@shopify/ui-extensions/checkout/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  EDITOR_PREVIEW_RECOMMENDATIONS,
  MAX_COMPLEMENTARY_GIDS_TO_RESOLVE,
  MAX_RECOMMENDATION_PRODUCTS_DISPLAY,
  PRODUCT_COMPLEMENTARY_METAFIELD_QUERY,
  PRODUCT_NODES_QUERY,
  COMPLEMENTARY_MANUAL_WEIGHT_OVERRIDES,
  complementaryGidsFromProductData,
  getFallbackProductGidsExcludingCart,
  getOrderedUniqueProductIds,
  mergeComplementaryGidsByWeightRows,
  parseWeightOverridesJson,
  normalizeNodesToRecommendationCards,
  orderCardsByGidOrderThenPrice,
} from "./recommendations.js";

/** 与 RecommendationItem 内 s-box 宽度一致，用于计算横向轨道总宽 */
const RECOMMENDATION_CARD_INLINE_PX = 172;
/**
 * gap="base" 在结账扩展里约对应 16px；用于估算轨道宽度，使内容宽于视口从而触发横向滚动。
 * （官方说明：s-grid 在列未约束时子项可能被压缩，仅靠 repeat 不一定产生溢出。）
 */
const CAROUSEL_GAP_BASE_APPROX_PX = 16;

function carouselTrackInlinePx(itemCount) {
  if (itemCount <= 0) return 0;
  return (
    itemCount * RECOMMENDATION_CARD_INLINE_PX +
    Math.max(0, itemCount - 1) * CAROUSEL_GAP_BASE_APPROX_PX
  );
}

export default async () => {
  render(<Extension />, document.body);
};

function RecommendationItem({
  item,
  i18n,
  isEditor,
  canAddCartLine,
  addingVariantId,
  onAdd,
}) {
  const variants =
    item.variants?.length > 0
      ? item.variants
      : [
          {
            variantId: item.variantId,
            label: "—",
            priceAmount: item.priceAmount,
            currencyCode: item.currencyCode,
          },
        ];

  const [selectedId, setSelectedId] = useState(variants[0]?.variantId ?? "");

  useEffect(() => {
    setSelectedId(variants[0]?.variantId ?? "");
  }, [item.productId]);

  const selected =
    variants.find((v) => v.variantId === selectedId) ?? variants[0];
  const showSelect = variants.length > 1;

  function handleSelectChange(event) {
    const el = event.currentTarget ?? event.target;
    const next = el?.value;
    if (typeof next === "string") setSelectedId(next);
  }

  return (
    <s-box inlineSize="172px" minInlineSize="172px">
      <s-stack gap="small">
        {item.imageUrl ? (
          <s-product-thumbnail
            src={item.imageUrl}
            alt={item.imageAlt}
            size="base"
          />
        ) : (
          <s-box
            inlineSize="100%"
            blockSize="80px"
            border="base"
            borderRadius="base"
          />
        )}
        <s-text type="strong">{item.title}</s-text>
        {showSelect ? (
          <s-select
            label={i18n.translate("chooseVariant")}
            name={`rec-variant-${item.productId}`}
            value={selectedId}
            disabled={isEditor}
            onChange={handleSelectChange}
          >
            {variants.map((v) => (
              <s-option key={v.variantId} value={v.variantId}>
                {v.label}
              </s-option>
            ))}
          </s-select>
        ) : null}
        <s-text color="subdued">
          {i18n.formatCurrency(selected.priceAmount, {
            currency: selected.currencyCode,
          })}
        </s-text>
        <s-button
          variant="secondary"
          loading={addingVariantId === selected.variantId}
          disabled={
            isEditor ||
            !canAddCartLine ||
            addingVariantId === selected.variantId
          }
          onClick={() => onAdd(selected.variantId)}
        >
          {isEditor
            ? i18n.translate("editorAddDisabled")
            : canAddCartLine
              ? i18n.translate("addToOrder")
              : i18n.translate("cannotAddToCart")}
        </s-button>
      </s-stack>
    </s-box>
  );
}

function Extension() {
  const settings = useSettings();
  const merchantWeightJson =
    typeof settings?.complementary_weight_overrides_json === "string"
      ? settings.complementary_weight_overrides_json
      : "";
  const weightOverrides = useMemo(
    () => ({
      ...COMPLEMENTARY_MANUAL_WEIGHT_OVERRIDES,
      ...parseWeightOverridesJson(merchantWeightJson),
    }),
    [merchantWeightJson],
  );

  const recommendationsLayoutRaw = settings?.recommendations_layout;
  const recommendationsLayout = useMemo(() => {
    const s =
      typeof recommendationsLayoutRaw === "string"
        ? recommendationsLayoutRaw.trim()
        : "";
    return s === "grid" ? "grid" : "carousel";
  }, [recommendationsLayoutRaw]);

  const editor = useExtensionEditor();
  const isEditor = editor?.type === "checkout";
  const lines = shopify.lines.value;
  const instructions = shopify.instructions.value;
  const canAddCartLine = instructions.lines?.canAddCartLine ?? false;
  const i18n = shopify.i18n;

  const sourceProductIds = getOrderedUniqueProductIds(lines);
  const sourceIdsKey = sourceProductIds.join("|");

  const cartProductIds = new Set(
    lines
      .filter((line) => line.merchandise?.type === "variant")
      .map((line) => line.merchandise.product.id),
  );

  const [rawRecommendations, setRawRecommendations] = useState([]);
  const [loadState, setLoadState] = useState("idle");
  const [queryError, setQueryError] = useState(null);
  const [addingVariantId, setAddingVariantId] = useState(null);

  useEffect(() => {
    if (isEditor) {
      setRawRecommendations(EDITOR_PREVIEW_RECOMMENDATIONS);
      setLoadState("ready");
      setQueryError(null);
      return;
    }

    if (sourceProductIds.length === 0) {
      setRawRecommendations([]);
      setLoadState("empty");
      setQueryError(null);
      return;
    }

    let cancelled = false;
    setLoadState("loading");
    setQueryError(null);

    Promise.allSettled(
      sourceProductIds.map((productId) =>
        shopify.query(PRODUCT_COMPLEMENTARY_METAFIELD_QUERY, {
          variables: { id: productId },
        }),
      ),
    )
      .then((settled) => {
        if (cancelled) return;

        const cartIdsNow = new Set(
          shopify.lines.value
            .filter((line) => line.merchandise?.type === "variant")
            .map((line) => line.merchandise.product.id),
        );

        function fetchOrderedCards(gids, weightByGid) {
          return shopify
            .query(PRODUCT_NODES_QUERY, { variables: { ids: gids } })
            .then(({ data, errors: nodeErrors }) => {
              if (cancelled) return { kind: "cancelled" };
              if (nodeErrors?.length) {
                return {
                  kind: "error",
                  message: nodeErrors.map((e) => e.message).join(", "),
                };
              }
              const cards = normalizeNodesToRecommendationCards(data);
              const ordered = orderCardsByGidOrderThenPrice(
                cards,
                gids,
                weightByGid,
              );
              return { kind: "ok", ordered };
            });
        }

        function applyFetchResult(res) {
          if (!res || res.kind === "cancelled") return;
          if (res.kind === "error") {
            setQueryError(res.message);
            setRawRecommendations([]);
            setLoadState("error");
            return;
          }
          setRawRecommendations(res.ordered);
          setLoadState("ready");
        }

        function tryFallbackOrEmpty() {
          const fb = getFallbackProductGidsExcludingCart(cartIdsNow);
          if (fb.length === 0) {
            setRawRecommendations([]);
            setLoadState("ready");
            return;
          }
          const fbRows = mergeComplementaryGidsByWeightRows(
            [fb],
            weightOverrides,
          );
          const fbWeightByGid = new Map(
            fbRows.map((r) => [r.gid, r.finalWeight]),
          );
          const orderedFb = fbRows.map((r) => r.gid);
          return fetchOrderedCards(orderedFb, fbWeightByGid).then(
            applyFetchResult,
          );
        }

        const gidLists = [];
        const errorMessages = [];

        for (const result of settled) {
          if (result.status === "rejected") {
            errorMessages.push(String(result.reason));
            gidLists.push([]);
            continue;
          }
          const { value } = result;
          if (value.errors?.length) {
            errorMessages.push(value.errors.map((e) => e.message).join(", "));
            gidLists.push([]);
            continue;
          }
          gidLists.push(complementaryGidsFromProductData(value.data));
        }

        const allPhase1Failed =
          settled.length > 0 &&
          settled.every(
            (r) =>
              r.status === "rejected" ||
              (r.status === "fulfilled" && r.value.errors?.length),
          );

        if (allPhase1Failed) {
          const fb = getFallbackProductGidsExcludingCart(cartIdsNow);
          if (fb.length > 0) {
            const fbRows = mergeComplementaryGidsByWeightRows(
              [fb],
              weightOverrides,
            );
            const fbWeightByGid = new Map(
              fbRows.map((r) => [r.gid, r.finalWeight]),
            );
            const orderedFb = fbRows.map((r) => r.gid);
            return fetchOrderedCards(orderedFb, fbWeightByGid).then(
              applyFetchResult,
            );
          }
          setQueryError(errorMessages.join(" · "));
          setRawRecommendations([]);
          setLoadState("error");
          return;
        }

        const mergeRows = mergeComplementaryGidsByWeightRows(
          gidLists,
          weightOverrides,
        );
        const weightByGid = new Map(
          mergeRows.map((r) => [r.gid, r.finalWeight]),
        );
        const mergedGids = mergeRows.map((r) => r.gid);
        const filteredGids = mergedGids
          .filter((gid) => !cartIdsNow.has(gid))
          .slice(0, MAX_COMPLEMENTARY_GIDS_TO_RESOLVE);

        if (filteredGids.length === 0) {
          return tryFallbackOrEmpty();
        }

        return fetchOrderedCards(filteredGids, weightByGid).then((res) => {
          if (!res || res.kind === "cancelled") return;
          if (res.kind === "error") {
            applyFetchResult(res);
            return;
          }
          if (res.ordered.length > 0) {
            applyFetchResult(res);
            return;
          }
          return tryFallbackOrEmpty();
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setQueryError(String(err));
          setRawRecommendations([]);
          setLoadState("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isEditor, sourceIdsKey, weightOverrides]);

  const visible = rawRecommendations
    .filter((item) => !cartProductIds.has(item.productId))
    .slice(0, MAX_RECOMMENDATION_PRODUCTS_DISPLAY);

  async function addVariant(variantId) {
    if (!canAddCartLine || isEditor) return;
    setAddingVariantId(variantId);
    try {
      await shopify.applyCartLinesChange({
        type: "addCartLine",
        merchandiseId: variantId,
        quantity: 1,
      });
    } finally {
      setAddingVariantId(null);
    }
  }

  const recommendationsTitle = i18n.translate("recommendationsHeading");

  if (loadState === "loading") {
    return (
      <s-stack gap="base">
        <s-heading>{recommendationsTitle}</s-heading>
        <s-stack gap="base" justifyContent="center">
          <s-spinner
            size="large"
            accessibilityLabel={i18n.translate("loadingRecommendations")}
          />
        </s-stack>
      </s-stack>
    );
  }

  if (loadState === "empty" && !isEditor) {
    return (
      <s-banner tone="info">
        <s-stack gap="small">
          <s-heading>{recommendationsTitle}</s-heading>
          <s-text>{i18n.translate("emptyCartHint")}</s-text>
        </s-stack>
      </s-banner>
    );
  }

  if (loadState === "error") {
    return (
      <s-banner tone="critical">
        <s-stack gap="small">
          <s-heading>{recommendationsTitle}</s-heading>
          <s-text>
            {i18n.translate("recommendationsError", {
              error: queryError ?? "",
            })}
          </s-text>
        </s-stack>
      </s-banner>
    );
  }

  if (visible.length === 0) {
    return (
      <s-banner tone="info">
        <s-stack gap="small">
          <s-heading>{recommendationsTitle}</s-heading>
          <s-text>{i18n.translate("noRecommendations")}</s-text>
        </s-stack>
      </s-banner>
    );
  }

  const trackInlinePx = carouselTrackInlinePx(visible.length);

  const recommendationCards = visible.map((item) => (
    <RecommendationItem
      key={item.productId}
      item={item}
      i18n={i18n}
      isEditor={isEditor}
      canAddCartLine={canAddCartLine}
      addingVariantId={addingVariantId}
      onAdd={addVariant}
    />
  ));

  return (
    <s-stack gap="base">
      <s-heading>{recommendationsTitle}</s-heading>
      {isEditor ? (
        <s-banner tone="info">
          <s-text>{i18n.translate("editorPreviewHint")}</s-text>
        </s-banner>
      ) : null}
      <s-stack gap="base">
        {recommendationsLayout === "grid" ? (
          <s-grid
            gap="base"
            inlineSize="100%"
            accessibilityLabel={i18n.translate("recommendationsGridLabel")}
            gridTemplateColumns={`repeat(auto-fill, minmax(${RECOMMENDATION_CARD_INLINE_PX}px, 1fr))`}
            justifyItems="start"
          >
            {recommendationCards}
          </s-grid>
        ) : (
          <s-scroll-box
            inlineSize="100%"
            maxInlineSize="100%"
            minInlineSize="0"
            accessibilityLabel={i18n.translate("recommendationsCarouselLabel")}
            overflow="hidden auto"
          >
            <s-box
              inlineSize={`${trackInlinePx}px`}
              minInlineSize={`${trackInlinePx}px`}
              padding="none"
            >
              <s-grid
                gap="base"
                inlineSize={`${trackInlinePx}px`}
                gridTemplateColumns={`repeat(${visible.length}, ${RECOMMENDATION_CARD_INLINE_PX}px)`}
              >
                {recommendationCards}
              </s-grid>
            </s-box>
          </s-scroll-box>
        )}
      </s-stack>
    </s-stack>
  );
}

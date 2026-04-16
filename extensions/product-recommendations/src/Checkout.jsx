import "@shopify/ui-extensions/preact";
import { useExtensionEditor } from "@shopify/ui-extensions/checkout/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  EXAMPLE_STATIC_RECOMMENDATIONS,
  MAX_COMPLEMENTARY_GIDS_TO_RESOLVE,
  PRODUCT_COMPLEMENTARY_METAFIELD_QUERY,
  PRODUCT_NODES_QUERY,
  complementaryGidsFromProductData,
  getFallbackProductGidsExcludingCart,
  getOrderedUniqueProductIds,
  mergeGidLists,
  normalizeNodesToRecommendationCards,
  orderCardsByGidOrder,
} from "./recommendations-example.js";

const MAX_VISIBLE_RECOMMENDATIONS = 16;

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
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
      setRawRecommendations(EXAMPLE_STATIC_RECOMMENDATIONS);
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

        function fetchOrderedCards(gids) {
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
              const ordered = orderCardsByGidOrder(cards, gids);
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
          return fetchOrderedCards(fb).then(applyFetchResult);
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
            return fetchOrderedCards(fb).then(applyFetchResult);
          }
          setQueryError(errorMessages.join(" · "));
          setRawRecommendations([]);
          setLoadState("error");
          return;
        }

        const mergedGids = mergeGidLists(gidLists);
        const filteredGids = mergedGids
          .filter((gid) => !cartIdsNow.has(gid))
          .slice(0, MAX_COMPLEMENTARY_GIDS_TO_RESOLVE);

        if (filteredGids.length === 0) {
          return tryFallbackOrEmpty();
        }

        return fetchOrderedCards(filteredGids).then((res) => {
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
  }, [isEditor, sourceIdsKey]);

  const visible = rawRecommendations
    .filter((item) => !cartProductIds.has(item.productId))
    .slice(0, MAX_VISIBLE_RECOMMENDATIONS);

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

  if (loadState === "loading") {
    return (
      <s-section heading={i18n.translate("recommendationsHeading")}>
        <s-stack gap="base" justifyContent="center">
          <s-spinner
            size="large"
            accessibilityLabel={i18n.translate("loadingRecommendations")}
          />
        </s-stack>
      </s-section>
    );
  }

  if (loadState === "empty" && !isEditor) {
    return (
      <s-banner tone="info" heading={i18n.translate("recommendationsHeading")}>
        <s-text>{i18n.translate("emptyCartHint")}</s-text>
      </s-banner>
    );
  }

  if (loadState === "error") {
    return (
      <s-banner
        tone="critical"
        heading={i18n.translate("recommendationsHeading")}
      >
        <s-text>
          {i18n.translate("recommendationsError", {
            error: queryError ?? "",
          })}
        </s-text>
      </s-banner>
    );
  }

  if (visible.length === 0) {
    return (
      <s-banner tone="info" heading={i18n.translate("recommendationsHeading")}>
        <s-text>{i18n.translate("noRecommendations")}</s-text>
      </s-banner>
    );
  }

  return (
    <s-section heading={i18n.translate("recommendationsHeading")}>
      {isEditor ? (
        <s-banner tone="info">
          <s-text>{i18n.translate("editorPreviewHint")}</s-text>
        </s-banner>
      ) : null}
      <s-stack gap="base">
        <s-scroll-box
          inlineSize="100%"
          accessibilityLabel={i18n.translate("recommendationsCarouselLabel")}
          overflow="hidden auto"
        >
          <s-stack direction="inline" gap="base">
            {visible.map((item) => (
              <s-box
                key={item.productId}
                inlineSize="152px"
                minInlineSize="152px"
              >
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
                  <s-text color="subdued">
                    {i18n.formatCurrency(item.priceAmount, {
                      currency: item.currencyCode,
                    })}
                  </s-text>
                  <s-button
                    variant="secondary"
                    loading={addingVariantId === item.variantId}
                    disabled={
                      isEditor ||
                      !canAddCartLine ||
                      addingVariantId === item.variantId
                    }
                    onClick={() => addVariant(item.variantId)}
                  >
                    {isEditor
                      ? i18n.translate("editorAddDisabled")
                      : canAddCartLine
                        ? i18n.translate("addToOrder")
                        : i18n.translate("cannotAddToCart")}
                  </s-button>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-scroll-box>
      </s-stack>
    </s-section>
  );
}

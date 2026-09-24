<script>
  import { _ } from '@sveltia/i18n';
  import { Button, EmptyState } from '@sveltia/ui';
  import { untrack } from 'svelte';

  import EntryEditor from '$lib/components/contents/details/editor/entry-editor.svelte';
  import EntryPreview from '$lib/components/contents/details/preview/entry-preview.svelte';
  import { getEntryDraftContext } from '$lib/services/contents/draft/state.svelte';
  import { toggleLocale } from '$lib/services/contents/draft/update/locale';
  import { entryEditorSettings } from '$lib/services/contents/editor/settings';
  import { getLocaleLabel } from '$lib/services/contents/i18n';

  /**
   * @import { EntryEditorPane } from '$lib/types/private';
   */

  /**
   * @typedef {object} Props
   * @property {string} id The wrapper element’s `id` attribute.
   * @property {{ current: ?EntryEditorPane }} thisPane This pane’s mode and locale.
   * @property {HTMLElement} [thisPaneContentArea] This pane’s content area, bound for the parent.
   * @property {HTMLElement} [thatPaneContentArea] Another pane’s content area.
   */

  const entryDraft = getEntryDraftContext();

  /** @type {Props} */
  let {
    /* eslint-disable prefer-const */
    id,
    thisPane,
    thisPaneContentArea = $bindable(),
    thatPaneContentArea = undefined,
    /* eslint-enable prefer-const */
  } = $props();

  const { syncScrolling } = $derived(entryEditorSettings.current ?? {});
  const locale = $derived(thisPane.current?.locale);
  const mode = $derived(thisPane.current?.mode);
  const hasContent = $derived(!!locale && !!entryDraft.current?.currentValues[locale]);
  /* v8 ignore start -- only read for a disabled locale, which the pane always has */
  const labelOptions = $derived({
    values: { locale: locale ? (getLocaleLabel(locale) ?? locale) : '' },
  });
  /* v8 ignore stop */
  const MainContent = $derived(mode === 'preview' ? EntryPreview : EntryEditor);

  /** @type {HTMLElement | undefined} */
  let contentArea = $state();

  /**
   * Sync the scroll position with the other edit/preview pane.
   */
  const syncScrollPosition = () => {
    window.requestAnimationFrame(() => {
      if (!syncScrolling || !contentArea || !thisPaneContentArea || !thatPaneContentArea) {
        return;
      }

      const isIframe = thisPaneContentArea !== contentArea;
      const { x, y } = isIframe ? { x: 0, y: 0 } : thisPaneContentArea.getBoundingClientRect();
      const { ownerDocument, scrollTop, scrollHeight, clientHeight } = thisPaneContentArea;
      const scrollTopMax = scrollHeight - clientHeight;
      const scrollRatio = scrollTop / scrollTopMax;

      // Find the field section in the top left corner of the content area. Use `findLast` to
      // capture the topmost element; otherwise the List field sticky headers will interfere with
      // the positioning.
      // @see https://github.com/sveltia/sveltia-cms/issues/883
      const matches = /** @type {HTMLElement[]} */ (
        ownerDocument.elementsFromPoint(x + 80, y).filter((e) => e.matches('[data-key-path]'))
      );

      let thisElement = /** @type {HTMLElement | undefined} */ (matches.at(-1));

      // When syncing with a preview rendered in an iframe, use the deepest field key path
      // instead: the outermost match is always the fields container (e.g. `sections`), which
      // custom preview templates do not anchor, while they anchor individual fields. Between two
      // editor panes (i18n), matching fields share the same structure and the container works.
      if (matches.length && (isIframe || thatPaneContentArea.ownerDocument !== document)) {
        thisElement = matches.reduce((a, b) =>
          (b.dataset.keyPath ?? '').split('.').length > (a.dataset.keyPath ?? '').split('.').length
            ? b
            : a,
        );
      }

      if (!thisElement) {
        // Calculate the scroll position based on the current scroll position of the this pane
        thatPaneContentArea.scrollTop = thatPaneContentArea.scrollHeight * scrollRatio;

        return;
      }

      // The element was found by that very attribute, so the key path is there
      const { keyPath } = /** @type {{ keyPath: string }} */ (thisElement.dataset);
      const { top, height } = thisElement.getBoundingClientRect();
      const ratio = (y - top) / height;

      const thatElement = /** @type {HTMLElement | undefined} */ (
        thatPaneContentArea.querySelector(`[data-key-path="${CSS.escape(keyPath)}"]`)
      );

      if (ratio < 0 || ratio > 1 || !thatElement) {
        return;
      }

      // Scroll the other pane to the corresponding element, adjusting for the current scroll
      // position and the ratio of the scroll position within the element. When the target pane is
      // an iframe, its geometry is independent from this pane’s: the pane offset must not be
      // subtracted (it would bias the preview upwards), and the result is clamped to the
      // scrollable range.
      if (thatPaneContentArea.ownerDocument !== document) {
        thatPaneContentArea.scrollTop = Math.min(
          Math.max(thatElement.offsetTop + thatElement.clientHeight * ratio, 0),
          thatPaneContentArea.scrollHeight - thatPaneContentArea.clientHeight,
        );
      } else {
        thatPaneContentArea.scrollTop =
          thatElement.offsetTop - y + thatElement.clientHeight * ratio;
      }
    });
  };

  /** @type {AddEventListenerOptions} */
  const eventOptions = { capture: true, passive: true };
  /** Counter to ignore an outdated initialization once a newer one has started. */
  let initCount = 0;

  /**
   * Wait for the preview iframe to appear on the content area. The iframe mounts asynchronously
   * (e.g. behind a visibility observer), so a single query when the effect runs is not enough, and
   * falling back to the content area would permanently break the synchronization. Resolves with
   * `null` when no iframe appears, e.g. when the built-in preview is used without a custom style.
   * @returns {Promise<HTMLIFrameElement | null>} The preview iframe, or `null`.
   */
  const waitForPreviewIframe = () =>
    new Promise((resolve) => {
      const iframe = /** @type {HTMLIFrameElement | null} */ (
        contentArea?.querySelector('iframe.preview')
      );

      if (iframe || !contentArea?.isConnected) {
        resolve(iframe);
        return;
      }

      const observer = new MutationObserver(() => {
        const found = /** @type {HTMLIFrameElement | null} */ (
          contentArea?.querySelector('iframe.preview')
        );

        if (found || !contentArea?.isConnected) {
          observer.disconnect();
          resolve(found);
        }
      });

      observer.observe(/** @type {HTMLElement} */ (contentArea), {
        childList: true,
        subtree: true,
      });

      // Preview styles/templates can still be registered after the pane is opened; give up after
      // some time and fall back to the content area
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, 10000);
    });

  /**
   * Wait for the given iframe document to be fully loaded and return its root element. An
   * arbitrary delay cannot guarantee that the document is the final one (the preview loads a
   * custom stylesheet), and listeners attached to an interim document never fire. The initial
   * `about:blank` document is also complete, hence the protocol check.
   * @param {HTMLIFrameElement} iframe Preview iframe.
   * @returns {Promise<HTMLElement | undefined>} The iframe document’s root element.
   */
  const waitForLoadedDocument = (iframe) =>
    new Promise((resolve) => {
      const doc = iframe.contentDocument;

      if (doc && doc.readyState === 'complete' && doc.location.protocol === 'blob:') {
        resolve(/** @type {HTMLElement} */ (doc.documentElement));
        return;
      }

      iframe.addEventListener(
        'load',
        () => resolve(/** @type {HTMLElement} */ (iframe.contentDocument?.documentElement)),
        { once: true },
      );
    });

  /**
   * Initialize the scroll synchronization by setting up event listeners and ensuring the content
   * area is ready. The content area is either the main content area or the iframe’s content area.
   * An iframe is used only when a custom preview stylesheet or template is provided, and both its
   * presence and its load state are asynchronous, so they are explicitly awaited.
   */
  const initializeScrollSync = async () => {
    if (!contentArea) {
      return;
    }

    initCount += 1;

    const currentCount = initCount;

    if (thisPaneContentArea) {
      // Remove previous event listeners if they exist
      thisPaneContentArea.removeEventListener('wheel', syncScrollPosition, eventOptions);
      thisPaneContentArea.removeEventListener('touchmove', syncScrollPosition, eventOptions);
    }

    // In edit mode, the content area is used as is. In preview mode, the content is rendered in
    // an iframe, which mounts and loads asynchronously.
    const iframe = mode === 'preview' ? await waitForPreviewIframe() : null;
    const rootElement = iframe ? await waitForLoadedDocument(iframe) : contentArea;

    if (currentCount !== initCount) {
      // The mode has changed in the meantime, and a newer initialization has taken over
      return;
    }

    // The pane may have been unmounted or re-initialized while waiting
    if (!rootElement || !contentArea?.isConnected) {
      return;
    }

    thisPaneContentArea = /** @type {HTMLElement} */ (rootElement);
    thisPaneContentArea.scrollTop = 0;
    // Add event listeners manually to use passive mode
    thisPaneContentArea.addEventListener('wheel', syncScrollPosition, eventOptions);
    thisPaneContentArea.addEventListener('touchmove', syncScrollPosition, eventOptions);
  };

  $effect(() => {
    // Initialize the scroll synchronization when the content area is ready. The pane mode is also a
    // dependency because the edit mode always uses the main content area, while the preview mode
    // may use an iframe if a custom preview stylesheet is provided.
    void [thisPane.current?.mode, contentArea];
    // The initialization writes `thisPaneContentArea`, which it also reads, so it’s left out of
    // the dependencies to keep the effect from running again on its own account
    untrack(() => initializeScrollSync());
  });
</script>

<div role="none" {id} class="wrapper">
  {#if locale && entryDraft.current?.currentLocales[locale]}
    <div role="none" class="content" bind:this={contentArea}>
      <MainContent {locale} />
    </div>
  {:else if mode === 'edit'}
    <EmptyState>
      <span role="alert">
        {_(hasContent ? 'locale_x_now_disabled' : 'locale_x_has_been_disabled', labelOptions)}
      </span>
      <Button
        variant="tertiary"
        label={_(hasContent ? 'reenable_x_locale' : 'enable_x_locale', labelOptions)}
        onclick={() => {
          /* v8 ignore next 3 -- the button is only offered for a disabled locale */
          if (locale && entryDraft.current) {
            toggleLocale({ draft: entryDraft.current, locale });
          }
        }}
      />
    </EmptyState>
  {/if}
</div>

<style>
  .wrapper {
    display: contents;
  }

  .content {
    --field-editor-padding: 16px;
    flex: auto;
    overflow-y: auto;
    scroll-behavior: auto; /* Don’t use smooth scroll for syncing */
    overscroll-behavior-y: contain;

    @media (width < 768px) {
      --field-editor-padding: 12px;
    }
  }
</style>

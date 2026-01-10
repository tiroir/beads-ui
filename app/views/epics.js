import { html, render } from 'lit-html';
import { createListSelectors } from '../data/list-selectors.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { createIssueRowRenderer } from './issue-row.js';

/**
 * @typedef {{ id: string, title?: string, status?: string, priority?: number, issue_type?: string, assignee?: string, created_at?: number, updated_at?: number }} IssueLite
 */

/**
 * Epics view (push-only):
 * - Derives epic groups from the local issues store (no RPC reads).
 * - Subscribes to `tab:epics` for top-level membership.
 * - On expand, subscribes to `detail:{id}` (issue-detail) for the epic.
 * - Renders children from the epic detail's `dependents` list.
 * - Provides inline edits via mutations; UI re-renders on push.
 *
 * @param {HTMLElement} mount_element
 * @param {{ updateIssue: (input: any) => Promise<any> }} data
 * @param {(id: string) => void} goto_issue - Navigate to issue detail.
 * @param {{ subscribeList: (client_id: string, spec: { type: string, params?: Record<string, string|number|boolean> }) => Promise<() => Promise<void>>, selectors: { getIds: (client_id: string) => string[], count?: (client_id: string) => number } }} [subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [issue_stores]
 * @param {{ getState: () => any, setState: (patch: any) => void, subscribe?: (fn: (s:any)=>void)=>()=>void }} [store]
 */
export function createEpicsView(
  mount_element,
  data,
  goto_issue,
  subscriptions = undefined,
  issue_stores = undefined,
  store = undefined
) {
  /** @type {any[]} */
  let groups = [];
  /** @type {Set<string>} */
  const expanded = new Set();
  /** @type {Set<string>} */
  const loading = new Set();
  /** @type {Map<string, () => Promise<void>>} */
  const epic_unsubs = new Map();
  /** @type {IssueLite[]} */
  let all_issues_cache = [];
  /** @type {string[]} */
  let client_filters = [];
  /** @type {string[]} */
  let work_filters = [];
  let client_dropdown_open = false;
  let work_dropdown_open = false;

  // Initialize label filters from store
  if (store) {
    const s = store.getState();
    if (s && s.filters && typeof s.filters === 'object') {
      client_filters = Array.isArray(s.filters.client) ? s.filters.client : [];
      work_filters = Array.isArray(s.filters.work) ? s.filters.work : [];
    }
  }

  // Subscribe to store for filter changes from other views
  if (store && store.subscribe) {
    store.subscribe((s) => {
      if (s && s.filters && typeof s.filters === 'object') {
        const next_client = Array.isArray(s.filters.client)
          ? s.filters.client
          : [];
        const next_work = Array.isArray(s.filters.work) ? s.filters.work : [];
        const client_changed =
          JSON.stringify(next_client) !== JSON.stringify(client_filters);
        const work_changed =
          JSON.stringify(next_work) !== JSON.stringify(work_filters);
        if (client_changed || work_changed) {
          client_filters = next_client;
          work_filters = next_work;
          groups = buildGroupsFromSnapshot();
          doRender();
        }
      }
    });
  }

  /**
   * Extract unique label values by prefix from all issues cache.
   *
   * @param {string} prefix - Label prefix (e.g., 'client:', 'work:')
   * @returns {string[]} - Sorted unique values without the prefix
   */
  function getLabelsByPrefix(prefix) {
    const values = new Set();
    for (const issue of all_issues_cache) {
      const labels = /** @type {any} */ (issue).labels;
      if (Array.isArray(labels)) {
        for (const label of labels) {
          if (typeof label === 'string' && label.startsWith(prefix)) {
            values.add(label.slice(prefix.length));
          }
        }
      }
    }
    return Array.from(values).sort();
  }

  /**
   * Check if an issue matches the selected label filters.
   * Uses AND logic: issue must have ALL selected labels.
   *
   * @param {IssueLite} issue
   * @returns {boolean}
   */
  function matchesLabelFilters(issue) {
    const labels = Array.isArray(/** @type {any} */ (issue).labels)
      ? /** @type {string[]} */ (/** @type {any} */ (issue).labels)
      : [];
    for (const client of client_filters) {
      if (!labels.includes(`client:${client}`)) {
        return false;
      }
    }
    for (const work of work_filters) {
      if (!labels.includes(`work:${work}`)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Toggle a client label filter.
   *
   * @param {string} client
   */
  function toggleClientFilter(client) {
    if (client_filters.includes(client)) {
      client_filters = client_filters.filter((c) => c !== client);
    } else {
      client_filters = [...client_filters, client];
    }
    if (store) {
      store.setState({ filters: { client: client_filters } });
    }
    groups = buildGroupsFromSnapshot();
    doRender();
  }

  /**
   * Toggle a work label filter.
   *
   * @param {string} work
   */
  function toggleWorkFilter(work) {
    if (work_filters.includes(work)) {
      work_filters = work_filters.filter((w) => w !== work);
    } else {
      work_filters = [...work_filters, work];
    }
    if (store) {
      store.setState({ filters: { work: work_filters } });
    }
    groups = buildGroupsFromSnapshot();
    doRender();
  }

  /**
   * Toggle client dropdown open/closed.
   *
   * @param {Event} e
   */
  function toggleClientDropdown(e) {
    e.stopPropagation();
    client_dropdown_open = !client_dropdown_open;
    work_dropdown_open = false;
    doRender();
  }

  /**
   * Toggle work dropdown open/closed.
   *
   * @param {Event} e
   */
  function toggleWorkDropdown(e) {
    e.stopPropagation();
    work_dropdown_open = !work_dropdown_open;
    client_dropdown_open = false;
    doRender();
  }

  /**
   * Get display text for dropdown trigger.
   *
   * @param {string[]} selected
   * @param {string} label
   * @returns {string}
   */
  function getDropdownDisplayText(selected, label) {
    if (selected.length === 0) return `${label}: Any`;
    if (selected.length === 1) return `${label}: ${selected[0]}`;
    return `${label} (${selected.length})`;
  }

  // Centralized selection helpers
  const selectors = issue_stores ? createListSelectors(issue_stores) : null;
  // Live re-render on pushes: recompute groups when stores change
  if (selectors) {
    selectors.subscribe(() => {
      const had_none = groups.length === 0;
      groups = buildGroupsFromSnapshot();
      doRender();
      // Auto-expand first epic when transitioning from empty to non-empty
      if (had_none && groups.length > 0) {
        const first_id = String(groups[0].epic?.id || '');
        if (first_id && !expanded.has(first_id)) {
          void toggle(first_id);
        }
      }
    });
  }

  // Shared row renderer used for children rows
  const renderRow = createIssueRowRenderer({
    navigate: (id) => goto_issue(id),
    onUpdate: updateInline,
    requestRender: doRender,
    getSelectedId: () => null,
    row_class: 'epic-row'
  });

  function doRender() {
    render(template(), mount_element);
  }

  function template() {
    const client_labels = getLabelsByPrefix('client:');
    const work_labels = getLabelsByPrefix('work:');
    const has_filters = client_labels.length > 0 || work_labels.length > 0;

    if (!groups.length) {
      return html`
        ${has_filters
          ? html`
              <div class="panel__header epics-filters">
                ${client_labels.length > 0
                  ? html`
                      <div
                        class="filter-dropdown ${client_dropdown_open
                          ? 'is-open'
                          : ''}"
                      >
                        <button
                          class="filter-dropdown__trigger"
                          @click=${toggleClientDropdown}
                        >
                          ${getDropdownDisplayText(client_filters, 'Client')}
                          <span class="filter-dropdown__arrow">▾</span>
                        </button>
                        <div class="filter-dropdown__menu">
                          ${client_labels.map(
                            (c) => html`
                              <label class="filter-dropdown__option">
                                <input
                                  type="checkbox"
                                  .checked=${client_filters.includes(c)}
                                  @change=${() => toggleClientFilter(c)}
                                />
                                ${c}
                              </label>
                            `
                          )}
                        </div>
                      </div>
                    `
                  : ''}
                ${work_labels.length > 0
                  ? html`
                      <div
                        class="filter-dropdown ${work_dropdown_open
                          ? 'is-open'
                          : ''}"
                      >
                        <button
                          class="filter-dropdown__trigger"
                          @click=${toggleWorkDropdown}
                        >
                          ${getDropdownDisplayText(work_filters, 'Work')}
                          <span class="filter-dropdown__arrow">▾</span>
                        </button>
                        <div class="filter-dropdown__menu">
                          ${work_labels.map(
                            (w) => html`
                              <label class="filter-dropdown__option">
                                <input
                                  type="checkbox"
                                  .checked=${work_filters.includes(w)}
                                  @change=${() => toggleWorkFilter(w)}
                                />
                                ${w}
                              </label>
                            `
                          )}
                        </div>
                      </div>
                    `
                  : ''}
              </div>
            `
          : ''}
        <div class="panel__header muted">No epics found.</div>
      `;
    }
    return html`
      ${has_filters
        ? html`
            <div class="panel__header epics-filters">
              ${client_labels.length > 0
                ? html`
                    <div
                      class="filter-dropdown ${client_dropdown_open
                        ? 'is-open'
                        : ''}"
                    >
                      <button
                        class="filter-dropdown__trigger"
                        @click=${toggleClientDropdown}
                      >
                        ${getDropdownDisplayText(client_filters, 'Client')}
                        <span class="filter-dropdown__arrow">▾</span>
                      </button>
                      <div class="filter-dropdown__menu">
                        ${client_labels.map(
                          (c) => html`
                            <label class="filter-dropdown__option">
                              <input
                                type="checkbox"
                                .checked=${client_filters.includes(c)}
                                @change=${() => toggleClientFilter(c)}
                              />
                              ${c}
                            </label>
                          `
                        )}
                      </div>
                    </div>
                  `
                : ''}
              ${work_labels.length > 0
                ? html`
                    <div
                      class="filter-dropdown ${work_dropdown_open
                        ? 'is-open'
                        : ''}"
                    >
                      <button
                        class="filter-dropdown__trigger"
                        @click=${toggleWorkDropdown}
                      >
                        ${getDropdownDisplayText(work_filters, 'Work')}
                        <span class="filter-dropdown__arrow">▾</span>
                      </button>
                      <div class="filter-dropdown__menu">
                        ${work_labels.map(
                          (w) => html`
                            <label class="filter-dropdown__option">
                              <input
                                type="checkbox"
                                .checked=${work_filters.includes(w)}
                                @change=${() => toggleWorkFilter(w)}
                              />
                              ${w}
                            </label>
                          `
                        )}
                      </div>
                    </div>
                  `
                : ''}
            </div>
          `
        : ''}
      ${groups.map((g) => groupTemplate(g))}
    `;
  }

  /**
   * @param {any} g
   */
  function groupTemplate(g) {
    const epic = g.epic || {};
    const id = String(epic.id || '');
    const is_open = expanded.has(id);
    // Compose children via selectors
    const raw_list = selectors ? selectors.selectEpicChildren(id) : [];
    // Apply label filters if any are selected
    const has_label_filters =
      client_filters.length > 0 || work_filters.length > 0;
    const list = has_label_filters
      ? raw_list.filter(matchesLabelFilters)
      : raw_list;
    const is_loading = loading.has(id);
    return html`
      <div class="epic-group" data-epic-id=${id}>
        <div
          class="epic-header"
          @click=${() => toggle(id)}
          role="button"
          tabindex="0"
          aria-expanded=${is_open}
        >
          ${createIssueIdRenderer(id, { class_name: 'mono' })}
          <span class="text-truncate" style="margin-left:8px"
            >${epic.title || '(no title)'}</span
          >
          <span
            class="epic-progress"
            style="margin-left:auto; display:flex; align-items:center; gap:8px;"
          >
            <progress
              value=${Number(g.closed_children || 0)}
              max=${Math.max(1, Number(g.total_children || 0))}
            ></progress>
            <span class="muted mono"
              >${g.closed_children}/${g.total_children}</span
            >
          </span>
        </div>
        ${is_open
          ? html`<div class="epic-children">
              ${is_loading
                ? html`<div class="muted">Loading…</div>`
                : list.length === 0
                  ? html`<div class="muted">No issues found</div>`
                  : html`<table class="table">
                      <colgroup>
                        <col style="width: 100px" />
                        <col style="width: 120px" />
                        <col />
                        <col style="width: 120px" />
                        <col style="width: 160px" />
                        <col style="width: 130px" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Type</th>
                          <th>Title</th>
                          <th>Status</th>
                          <th>Assignee</th>
                          <th>Priority</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${list.map((it) => renderRow(it))}
                      </tbody>
                    </table>`}
            </div>`
          : null}
      </div>
    `;
  }

  /**
   * @param {string} id
   * @param {{ [k: string]: any }} patch
   */
  async function updateInline(id, patch) {
    try {
      await data.updateIssue({ id, ...patch });
      // Re-render; view will update on subsequent push
      doRender();
    } catch {
      // swallow; UI remains
    }
  }

  /**
   * @param {string} epic_id
   */
  async function toggle(epic_id) {
    if (!expanded.has(epic_id)) {
      expanded.add(epic_id);
      loading.add(epic_id);
      doRender();
      // Subscribe to epic detail; children are rendered from `dependents`
      if (subscriptions && typeof subscriptions.subscribeList === 'function') {
        try {
          // Register store first to avoid dropping the initial snapshot
          try {
            if (issue_stores && /** @type {any} */ (issue_stores).register) {
              /** @type {any} */ (issue_stores).register(`detail:${epic_id}`, {
                type: 'issue-detail',
                params: { id: epic_id }
              });
            }
          } catch {
            // ignore
          }
          const u = await subscriptions.subscribeList(`detail:${epic_id}`, {
            type: 'issue-detail',
            params: { id: epic_id }
          });
          epic_unsubs.set(epic_id, u);
        } catch {
          // ignore subscription failures
        }
      }
      // Mark as not loading after subscribe attempt; membership will stream in
      loading.delete(epic_id);
    } else {
      expanded.delete(epic_id);
      // Unsubscribe when collapsing
      if (epic_unsubs.has(epic_id)) {
        try {
          const u = epic_unsubs.get(epic_id);
          if (u) {
            await u();
          }
        } catch {
          // ignore
        }
        epic_unsubs.delete(epic_id);
        try {
          if (issue_stores && /** @type {any} */ (issue_stores).unregister) {
            /** @type {any} */ (issue_stores).unregister(`detail:${epic_id}`);
          }
        } catch {
          // ignore
        }
      }
    }
    doRender();
  }

  /** Build groups from the current `tab:epics` snapshot. */
  function buildGroupsFromSnapshot() {
    /** @type {IssueLite[]} */
    const epic_entities =
      issue_stores && issue_stores.snapshotFor
        ? /** @type {IssueLite[]} */ (
            issue_stores.snapshotFor('tab:epics') || []
          )
        : [];
    const next_groups = [];
    /** @type {IssueLite[]} */
    const all_issues = [];
    for (const epic of epic_entities) {
      const dependents = Array.isArray(/** @type {any} */ (epic).dependents)
        ? /** @type {any[]} */ (/** @type {any} */ (epic).dependents)
        : [];
      // Collect all issues for label extraction
      all_issues.push(epic);
      all_issues.push(...dependents);
      // Prefer explicit counters when provided by server; otherwise derive
      const has_total = Number.isFinite(
        /** @type {any} */ (epic).total_children
      );
      const has_closed = Number.isFinite(
        /** @type {any} */ (epic).closed_children
      );
      const total = has_total
        ? Number(/** @type {any} */ (epic).total_children) || 0
        : dependents.length;
      let closed = has_closed
        ? Number(/** @type {any} */ (epic).closed_children) || 0
        : 0;
      if (!has_closed) {
        for (const d of dependents) {
          if (String(d.status || '') === 'closed') {
            closed++;
          }
        }
      }
      next_groups.push({
        epic,
        total_children: total,
        closed_children: closed
      });
    }
    // Update cache for label extraction
    all_issues_cache = all_issues;
    return next_groups;
  }

  return {
    async load() {
      groups = buildGroupsFromSnapshot();
      doRender();
      // Auto-expand first epic on screen
      try {
        if (groups.length > 0) {
          const first_id = String(groups[0].epic?.id || '');
          if (first_id && !expanded.has(first_id)) {
            // This will render and load children lazily
            await toggle(first_id);
          }
        }
      } catch {
        // ignore auto-expand failures
      }
    }
  };
}

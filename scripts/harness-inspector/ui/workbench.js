(() => {
  const report = JSON.parse(document.getElementById("inspector-data").textContent);
  const byNode = new Map(report.featureTree.nodes.map(node => [node.id,node]));
  const byStory = new Map(report.stories.map(story => [story.id,story]));
  const bySession = new Map(report.sessions.map(session => [session.sessionId,session]));
  const byCommit = new Map(report.commits.map(commit => [commit.hash,commit]));
  const storyScore = story => story.sessionLinks.reduce((score, link) => {
    const session = bySession.get(link.sessionId);
    if (!session) return score;
    return score + session.commitLinks.reduce((sum, commit) => sum + (commit.overlappingFiles?.length ?? 0), 0) + session.toolActivity.files.length;
  }, 0);
  const storyLastSeen = story => Math.max(0,...story.sessionLinks.map(link => new Date(bySession.get(link.sessionId)?.lastSeen ?? 0).getTime()).filter(Number.isFinite));
  const stageMatchedStories = report.stories.filter(story => story.stage === report.filters.stage);
  const eligibleStories = report.filters.stage && stageMatchedStories.length > 0 ? stageMatchedStories : report.stories;
  const initialStory = [...eligibleStories].sort((left,right) => storyLastSeen(right) - storyLastSeen(left) || storyScore(right) - storyScore(left))[0] ?? report.stories[0];
  const initialFeature = initialStory?.id ?? report.featureTree.roots[0] ?? null;
  const latestDay = report.days.at(-1)?.date ?? null;
  const state = { mode: report.featureTree.nodes.length ? "feature" : "date", scope: report.featureTree.nodes.length ? initialFeature : latestDay };
  const escape = value => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
  const formatDuration = value => Number.isFinite(value) ? (value >= 3600000 ? (value / 3600000).toFixed(1) + "h" : Math.max(1,Math.round(value / 60000)) + "m") : "unknown";
  const formatTokens = usage => {
    const total = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0);
    return total >= 1000 ? (Math.round(total / 100) / 10) + 'K tokens' : total + ' tokens';
  };
  const evidence = (kind, label = kind) => '<span class="evidence ' + escape(kind) + '">' + escape(label) + '</span>';

  function descendantStories(nodeId) {
    const node = byNode.get(nodeId);
    if (!node) return [];
    if (node.type === "story") return [byStory.get(node.id)].filter(Boolean);
    const result = [];
    const queue = [...node.children];
    while (queue.length) {
      const child = byNode.get(queue.shift());
      if (!child) continue;
      if (child.type === "story") result.push(byStory.get(child.id));
      queue.push(...child.children);
    }
    return result.filter(Boolean);
  }

  function scopedItems() {
    if (state.mode === "date") {
      const day = report.days.find(item => item.date === state.scope);
      const rows = (day?.sessionIds ?? []).map(sessionId => ({ story:null, session:bySession.get(sessionId), link:{ evidenceKind:"contextual", confidence:"date" }, date:day })).filter(item => item.session);
      const sessionLinked = new Set(rows.flatMap(row => row.session.commitLinks.filter(link => byCommit.get(link.hash)?.day === day?.date).map(link => link.hash)));
      const unassignedCommitHashes = (day?.commitHashes ?? []).filter(hash => !sessionLinked.has(hash));
      if (unassignedCommitHashes.length) rows.push({ story:null, session:null, link:{ evidenceKind:"contextual", confidence:"date" }, date:day, unassignedCommitHashes });
      return rows;
    }
    const stories = descendantStories(state.scope);
    const rows = [];
    for (const story of stories) {
      if (!story.sessionLinks.length) rows.push({ story, session:null, link:{ evidenceKind:story.evidence, confidence:"tree" }, date:null });
      for (const link of story.sessionLinks) rows.push({ story, session:bySession.get(link.sessionId) ?? null, link, date:null });
    }
    return rows;
  }

  function commitsFor(item) {
    const hashes = new Set(item.story?.commitHashes ?? []);
    for (const link of item.session?.commitLinks ?? []) {
      if (!item.date || byCommit.get(link.hash)?.day === item.date.date) hashes.add(link.hash);
    }
    for (const hash of item.unassignedCommitHashes ?? []) hashes.add(hash);
    return [...hashes].map(hash => byCommit.get(hash)).filter(Boolean).sort((a,b) => String(b.committedAt).localeCompare(String(a.committedAt)));
  }

  function promptLane(item) {
    const session = item.session;
    const prompts = session?.prompts ?? [];
    const declaredPrompt = item.story?.refs?.prompts?.[0];
    const cards = [];
    if (declaredPrompt) cards.push('<article class="intent-card declared-intent"><p>' + escape(declaredPrompt) + '</p><small>Feature Tree intent · ' + escape(item.story.evidence) + '</small></article>');
    prompts.forEach((prompt,index) => cards.push('<article class="intent-card"><p>' + escape(prompt.text) + '</p><small>User turn ' + (index + 1) + (prompt.timestamp ? ' · ' + escape(prompt.timestamp) : '') + '</small></article>'));
    const counts = session ? session.retainedUserTurnCount + ' shown · ' + session.userTurnCount + ' normalized · ' + session.promptObservationCount + ' observations' : 'no linked session';
    return '<section class="lane prompt-lane"><div class="lane-title"><strong>User prompts</strong><span>' + escape(counts) + '</span></div>' + (cards.join("") || '<div class="empty-state">No retained privacy-safe user turn for this scope.</div>') + '</section>';
  }

  function activityLane(item) {
    const session = item.session;
    if (!session) return '<section class="lane activity-lane"><div class="lane-title"><strong>Normalized activity</strong><span>0 calls</span></div><div class="empty-state">A session link is required before activity can be inspected.</div></section>';
    const activity = session.toolActivity;
    const actionCounts = new Map();
    activity.calls.forEach(call => actionCounts.set(call.actionLabel,(actionCounts.get(call.actionLabel) ?? 0) + 1));
    const rankedActions = [...actionCounts.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0,6);
    const max = Math.max(...rankedActions.map(([,count]) => count),1);
    const bars = rankedActions.map(([actionLabel,count]) => '<div class="family-row"><span title="' + escape(actionLabel) + '">' + escape(actionLabel) + '</span><div class="family-track"><div class="family-fill" style="width:' + Math.max(2,(count/max)*100) + '%"></div></div><strong>' + count + '</strong></div>').join("");
    return '<section class="lane activity-lane"><div class="lane-title"><strong>Checkpoint activity</strong><span>' + activity.files.length + ' file-attributed paths</span></div><div class="activity-summary"><div class="activity-total"><strong>' + activity.totalCalls + '</strong><span>calls · ' + activity.failedCalls + ' failed · ' + activity.segments.length + ' segments</span></div><div class="family-bars">' + bars + '</div></div><details class="activity-details" data-activity-session="' + escape(session.sessionId) + '"><summary><span>Expand ' + activity.totalCalls + ' normalized actions</span><small>focus view</small></summary><div class="trace-target" data-trace-target="' + escape(session.sessionId) + '"></div></details></section>';
  }

  function fileTree(commit, link) {
    const overlap = new Set(link?.overlappingFiles ?? []);
    const groups = new Map();
    for (const file of commit.files) {
      const parts = file.path.split('/');
      const folder = parts.length > 1 ? parts.shift() : '(root)';
      if (!groups.has(folder)) groups.set(folder,[]);
      groups.get(folder).push({ ...file, display:parts.join('/') || file.path });
    }
    return [...groups.entries()].map(([folder,files]) => '<div class="folder">' + escape(folder) + '</div>' + files.map(file => {
      const shared = overlap.has(file.path);
      const sharedKind = link?.evidenceKind === 'file-context' ? 'file-context' : 'observed-overlap';
      const sharedLabel = link?.evidenceKind === 'file-context' ? 'same path' : 'observed same-path';
      return '<div class="file-row"><code title="' + escape(file.path) + '">' + escape(file.display) + '</code><span class="delta">' + (Number.isFinite(file.added) ? '+' + file.added : 'bin') + ' / ' + (Number.isFinite(file.removed) ? '-' + file.removed : 'bin') + ' ' + evidence(shared ? sharedKind : 'commit-change', shared ? sharedLabel : 'commit') + '</span></div>';
    }).join('')).join('');
  }

  function deliveryLane(item, commits) {
    const cards = commits.map(commit => {
      const link = item.session?.commitLinks?.find(candidate => candidate.hash === commit.hash) ?? null;
      const kind = link?.evidenceKind ?? (item.story?.commitHashes?.includes(commit.hash) ? item.story.evidence : 'contextual');
      const label = kind === 'file-context' ? 'same-file history' : kind === 'observed-overlap' ? 'observed same-path' : kind;
      const relation = link ? (link.evidenceKind === 'file-context' ? ' · same-file context' : ' · ' + escape(link.confidence) + ' correlation') : '';
      return '<article class="commit-card"><div class="commit-head"><div class="commit-head-line"><code>' + escape(commit.shortHash) + '</code>' + evidence(kind,label) + '</div><p>' + escape(commit.subject) + '</p><div class="commit-stats">' + commit.fileCount + ' files · +' + commit.linesAdded + ' / -' + commit.linesRemoved + relation + '</div></div><div class="file-tree">' + (fileTree(commit,link) || '<div class="empty-state">No changed paths retained.</div>') + '</div></article>';
    }).join('');
    return '<section class="lane delivery-lane"><div class="lane-title"><div class="delivery-title-copy"><strong>Commits / files</strong><span>' + commits.length + ' commits</span></div><button class="delivery-toggle" data-toggle-delivery aria-expanded="true" aria-label="Collapse commits and files"><span class="open-label">Hide</span><span class="closed-label">Show files</span></button></div><div class="delivery-content">' + (cards || '<div class="empty-state">No commit is linked to this session or Story.</div>') + '</div></section>';
  }

  function workbench(item,index) {
    const commits = commitsFor(item);
    const title = item.story?.title ?? ('Activity on ' + (item.date?.date ?? item.session?.day ?? 'unknown date'));
    const session = item.session;
    const sessionMeta = session ? session.locator + ' · ' + formatDuration(session.durationMs) : 'No linked session';
    const sessionAction = session ? '<button class="prepare-button" data-open-session="' + index + '">Open session</button>' : '';
    return '<article class="workbench" data-workbench="' + index + '"><header class="workbench-head"><div><small>' + escape(item.story?.featureTitle ?? (item.date ? 'Date scope' : 'Unmapped')) + '</small><h3>' + escape(title) + '</h3><div class="meta">' + escape(sessionMeta) + '</div></div><div class="head-actions">' + evidence(item.link.evidenceKind) + sessionAction + '</div></header><div class="workbench-grid">' + promptLane(item) + '<div class="lane-resizer prompt" data-resize-lane="prompt" role="separator" aria-orientation="vertical" aria-label="Resize prompt and activity lanes" tabindex="0"></div>' + activityLane(item) + '<div class="lane-resizer delivery" data-resize-lane="delivery" role="separator" aria-orientation="vertical" aria-label="Resize activity and delivery lanes" tabindex="0"></div>' + deliveryLane(item,commits) + '</div></article>';
  }

  function continuationText(item) {
    const commits = commitsFor(item);
    const lines = ['Harness Inspector continuation context (read-only)',''];
    if (item.story) lines.push('Story: ' + item.story.title + ' [' + item.story.id + ']','Story evidence: ' + item.story.evidence);
    if (item.session) lines.push('Session locator: ' + item.session.locator,'Session window: ' + (item.session.firstSeen ?? 'unknown') + ' — ' + (item.session.lastSeen ?? 'unknown'),'Normalized user turns: ' + item.session.userTurnCount,'Normalized tool calls: ' + item.session.toolActivity.totalCalls);
    if (item.session?.prompts?.length) lines.push('','User turns:',...item.session.prompts.map((prompt,index) => '- ' + (index + 1) + '. ' + prompt.text));
    if (commits.length) lines.push('','Commits:',...commits.map(commit => '- ' + commit.shortHash + ' ' + commit.subject));
    const overlaps = commits.flatMap(commit => item.session?.commitLinks?.find(link => link.hash === commit.hash)?.overlappingFiles ?? []);
    if (overlaps.length) lines.push('','Exact shared paths (context only unless the commit link is explicit/correlated):',...[...new Set(overlaps)].map(file => '- ' + file));
    lines.push('','Boundary: this context does not restore code, mutate Git/workspace state, or resume a native Codex session.');
    return lines.join('\\n');
  }

  function sessionViewMarkup(item) {
    const session = item.session;
    const commits = commitsFor(item);
    const title = item.story?.title ?? session.prompts?.[0]?.text ?? session.locator;
    const toolCounts = new Map();
    session.toolActivity.calls.forEach(call => toolCounts.set(call.toolName,(toolCounts.get(call.toolName) ?? 0) + 1));
    const rankedTools = [...toolCounts.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const fallbackTurns = session.prompts.map((prompt,index) => ({ index:index + 1, anchorId:'turn-' + (index + 1), prompt, steps:[], response:null, durationMs:null }));
    const turns = session.dialogue?.turns?.length ? session.dialogue.turns : fallbackTurns;
    const commitBuckets = turns.map(() => []);
    commits.forEach(commit => {
      const commitTime = new Date(commit.committedAt ?? commit.authoredAt ?? 0).getTime();
      let target = 0;
      turns.forEach((turn,index) => {
        const turnTime = Number.isFinite(turn.startMs) ? turn.startMs : new Date(turn.prompt?.timestamp ?? 0).getTime();
        if (Number.isFinite(turnTime) && turnTime <= commitTime) target = index;
      });
      commitBuckets[Math.min(target,Math.max(0,turns.length - 1))]?.push(commit);
    });
    const toolRow = step => '<div class="session-tool-row" data-session-tool-row data-tool="' + escape(step.toolName) + '"><span>' + escape(step.callId) + '</span><span class="session-tool-copy"><strong>' + escape(step.actionLabel) + '</strong><code title="' + escape(step.toolName) + '">' + escape(step.toolName) + '</code></span><small>' + (step.durationStatus === 'observed' ? escape(step.durationMs + 'ms') : '—') + '</small>' + (step.detail ? '<code class="session-tool-detail">' + escape(step.detail) + '</code>' : '') + (step.filePaths?.length ? '<code class="session-tool-file">' + escape(step.filePaths.join(' · ')) + '</code>' : '') + '</div>';
    const commitEvent = commit => '<article class="session-event commit" data-session-event="commits" id="session-commit-' + escape(commit.shortHash) + '"><header class="session-event-head"><strong>' + escape(commit.shortHash) + ' · ' + escape(commit.subject) + '</strong><span>' + commit.fileCount + ' files</span></header><div class="session-event-body"><p>+' + commit.linesAdded + ' / -' + commit.linesRemoved + ' · commit evidence; shared paths remain contextual.</p></div></article>';
    const turnEvents = turns.map((turn,index) => {
      const prompt = '<article class="session-event prompt" data-session-event="prompts"><header class="session-event-head"><strong>User prompt ' + turn.index + '</strong><span>' + escape(turn.prompt?.timestamp ?? '') + '</span></header><div class="session-event-body session-prose"><p>' + escape(turn.prompt?.text ?? 'Prompt unavailable after privacy filtering') + '</p></div></article>';
      const notes = turn.steps.filter(step => step.kind === 'note').map((step,noteIndex) => '<article class="session-event intermediate" data-session-event="intermediate"><div class="session-note-label">Intermediate response ' + (noteIndex + 1) + '</div><p>' + escape(step.text) + '</p></article>').join('');
      const tools = turn.steps.filter(step => step.kind === 'tool');
      const toolEvent = tools.length ? '<details class="session-event tools" data-session-event="tools"><summary class="session-event-head"><strong>' + tools.length + ' tool call' + (tools.length === 1 ? '' : 's') + '</strong><span>' + turn.toolCallCount + ' observed in turn</span></summary><div class="session-call-list">' + tools.map(toolRow).join('') + '</div></details>' : '';
      const response = '<article class="session-event response' + (turn.response ? '' : ' session-unavailable') + '" data-session-event="responses"><header class="session-event-head"><strong>Assistant response</strong><span>' + (turn.response ? 'retained' : 'unavailable') + '</span></header><div class="session-event-body session-prose"><p>' + escape(turn.response ?? 'Response body was unavailable or removed by privacy filtering.') + '</p></div></article>';
      const summary = turn.messageCount + ' messages · ' + turn.toolCallCount + ' tool calls' + (Number.isFinite(turn.durationMs) ? ' · ' + formatDuration(turn.durationMs) : '');
      return '<section class="session-turn" id="session-' + escape(turn.anchorId) + '"><header class="session-turn-head"><strong>Turn ' + turn.index + '</strong><span>' + escape(summary) + '</span></header>' + prompt + notes + toolEvent + response + commitBuckets[index].map(commitEvent).join('') + '</section>';
    }).join('');
    const filters = rankedTools.slice(0,8).map(([toolName,count]) => '<label class="session-filter subtype"><input type="checkbox" checked data-session-tool-filter="' + escape(toolName) + '"><span>' + escape(toolName) + '</span><em>' + count + '</em></label>').join('');
    const sourceLabel = session.source === 'entire-checkpoint' ? 'Entire checkpoint' : 'Native session';
    const responseCount = session.dialogue?.responseCount ?? turns.filter(turn => turn.response).length;
    const noteCount = session.dialogue?.noteCount ?? turns.reduce((sum,turn) => sum + turn.steps.filter(step => step.kind === 'note').length,0);
    const truncatedNote = session.dialogue?.truncated ? '<span class="session-warning">Turn projection truncated</span>' : '';
    return { title, html:'<div class="session-shell"><header class="session-titlebar"><div><h2>' + escape(title) + '</h2><div class="session-meta"><span class="session-platform">' + escape(session.platform) + '</span><span>' + escape(session.models.join(', ') || 'model unavailable') + '</span><span>' + formatDuration(session.durationMs) + '</span><span>' + turns.length + ' turns</span><span>' + session.toolActivity.totalCalls + ' tool calls</span><span>' + session.fileEditCount + ' file edits</span><span>' + formatTokens(session.tokenUsage) + '</span>' + truncatedNote + '</div></div><button class="session-context-button" data-session-context>Continuation packet</button></header><div class="session-layout"><main class="session-timeline">' + (turnEvents || '<div class="empty-state">No retained dialogue turns for this session.</div>') + '</main><aside class="session-sidebar"><section><h3>Jump to</h3><select class="jump-select" data-session-jump>' + turns.map(turn => '<option value="session-' + escape(turn.anchorId) + '">Turn ' + turn.index + '</option>').join('') + commits.map(commit => '<option value="session-commit-' + escape(commit.shortHash) + '">' + escape(commit.shortHash) + '</option>').join('') + '</select></section><section><h3>Filters</h3><div class="session-filter-list"><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="prompts"><span>Prompts</span><em>' + turns.length + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="responses"><span>Responses</span><em>' + responseCount + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="intermediate"><span>Intermediate</span><em>' + noteCount + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="commits"><span>Commits</span><em>' + commits.length + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="tools"><span>Tool calls</span><em>' + session.toolActivity.totalCalls + '</em></label>' + filters + '<label class="session-filter subtype"><input type="checkbox" checked data-session-file-filter><span>File paths</span><em>' + session.toolActivity.files.length + '</em></label></div></section><section><h3>Source</h3><div class="session-meta"><span>' + sourceLabel + '</span></div></section></aside></div></div>' };
  }

  function applySessionFilters() {
    document.querySelectorAll('[data-session-kind-filter]').forEach(input => {
      document.querySelectorAll('[data-session-event="' + CSS.escape(input.dataset.sessionKindFilter) + '"]').forEach(event => event.classList.toggle('session-hidden',!input.checked));
    });
    document.querySelectorAll('[data-session-tool-filter]').forEach(input => {
      document.querySelectorAll('[data-session-tool-row][data-tool="' + CSS.escape(input.dataset.sessionToolFilter) + '"]').forEach(row => row.classList.toggle('session-hidden',!input.checked));
    });
    const fileFilter = document.querySelector('[data-session-file-filter]');
    document.querySelectorAll('.session-tool-file').forEach(file => file.classList.toggle('session-hidden',fileFilter && !fileFilter.checked));
  }

  function openSessionView(item) {
    const view = sessionViewMarkup(item);
    state.sessionItem = item;
    document.getElementById('session-view-title').textContent = view.title;
    document.getElementById('session-view-body').innerHTML = view.html;
    document.getElementById('session-view').hidden = false;
    document.getElementById('session-view-close').focus();
  }

  function showSwimlaneDetail(bubble) {
    const inspector = bubble.closest('.swimlane-chart-card')?.querySelector('[data-swimlane-inspector]');
    if (!inspector) return;
    const detail = bubble.dataset.detail ? '<code>' + escape(bubble.dataset.detail) + '</code>' : '<span>Input detail withheld or unavailable.</span>';
    const files = bubble.dataset.files ? '<span class="swimlane-inspector-files">' + escape(bubble.dataset.files) + '</span>' : '<span>No repository file attributed.</span>';
    inspector.innerHTML = '<div><strong>' + escape(bubble.dataset.callId + ' · ' + bubble.dataset.action) + '</strong><span>' + escape(bubble.dataset.tool + ' · ' + bubble.dataset.status + ' · ' + bubble.dataset.duration) + '</span></div><div>' + detail + files + '</div>';
  }

  function layoutSwimlane(svg) {
    const scroll = svg.closest('.swimlane-scroll');
    const minWidth = Number(svg.dataset.minWidth) || 560;
    const labelWidth = Number(svg.dataset.labelWidth) || 126;
    const totalCalls = Math.max(1,Number(svg.dataset.totalCalls) || 1);
    const height = Number(svg.getAttribute('height')) || 260;
    const layoutWidth = Math.max(minWidth,Math.floor(scroll?.clientWidth || minWidth));
    const plotLeft = labelWidth + 18;
    const plotRight = layoutWidth - 18;
    const plotWidth = Math.max(40,plotRight - plotLeft);
    const xFor = step => plotLeft + ((Math.max(1,Math.min(totalCalls,step)) - 1) / Math.max(1,totalCalls - 1)) * plotWidth;
    svg.setAttribute('width',String(layoutWidth));
    svg.setAttribute('viewBox','0 0 ' + layoutWidth + ' ' + height);
    svg.querySelectorAll('[data-swimlane-step]').forEach(element => {
      const x = xFor(Number(element.dataset.swimlaneStep));
      if (element.tagName === 'circle') element.setAttribute('cx',String(x));
      else if (element.tagName === 'line') {
        element.setAttribute('x1',String(x));
        element.setAttribute('x2',String(x));
      } else element.setAttribute('x',String(x));
    });
    svg.querySelectorAll('[data-swimlane-plot-end]').forEach(element => element.setAttribute('x2',String(layoutWidth - 9)));
    svg.querySelectorAll('[data-swimlane-row-alt]').forEach(element => element.setAttribute('width',String(layoutWidth - labelWidth)));
  }

  const swimlaneObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => entries.forEach(entry => entry.target.querySelectorAll('[data-swimlane-responsive]').forEach(layoutSwimlane)))
    : null;

  function initializeSwimlanes(root) {
    root.querySelectorAll('[data-swimlane-responsive]').forEach(svg => {
      layoutSwimlane(svg);
      const scroll = svg.closest('.swimlane-scroll');
      if (scroll) swimlaneObserver?.observe(scroll);
    });
  }

  function renderScope() {
    const items = scopedItems();
    const sessions = [...new Map(items.map(item => item.session).filter(Boolean).map(session => [session.sessionId,session])).values()];
    const commits = new Map(items.flatMap(item => commitsFor(item)).map(commit => [commit.hash,commit]));
    const stories = new Set(items.map(item => item.story?.id).filter(Boolean));
    const node = state.mode === 'feature' ? byNode.get(state.scope) : null;
    document.getElementById('workspace-scope-crumb').textContent = node?.title ?? state.scope ?? 'No scope';
    const metricValues = {
      stories: stories.size,
      sessions: sessions.length,
      calls: sessions.reduce((sum,session) => sum + session.toolActivity.totalCalls,0),
      commits: commits.size,
    };
    Object.entries(metricValues).forEach(([name,value]) => {
      const metric = document.querySelector('[data-metric="' + name + '"]');
      const output = metric?.querySelector('strong');
      if (output) output.textContent = value;
      if (metric) metric.hidden = value === 0;
    });
    document.getElementById('workbench-list').innerHTML = items.map(workbench).join('') || '<div class="empty-state">No provenance workbench exists in this scope.</div>';
    document.querySelectorAll('[data-feature-id]').forEach(button => button.classList.toggle('active', state.mode === 'feature' && button.dataset.featureId === state.scope));
    document.querySelectorAll('[data-date]').forEach(button => button.classList.toggle('active', state.mode === 'date' && button.dataset.date === state.scope));
    state.items = items;
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode === 'feature' && !byNode.has(state.scope)) state.scope = initialFeature;
    if (mode === 'date' && !report.days.some(day => day.date === state.scope)) state.scope = latestDay;
    document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('active',button.dataset.mode === mode));
    document.querySelectorAll('.picker-panel').forEach(panel => panel.classList.toggle('active',panel.dataset.panel === mode));
    renderScope();
  }

  function setTreeItemExpanded(item, expanded) {
    if (!item?.hasAttribute('aria-expanded')) return;
    item.setAttribute('aria-expanded',String(expanded));
    item.classList.toggle('collapsed',!expanded);
    const toggle = item.querySelector(':scope > .tree-line [data-tree-toggle]');
    if (toggle) {
      toggle.setAttribute('aria-expanded',String(expanded));
      const title = item.querySelector(':scope > .tree-line [data-feature-id] .tree-copy strong')?.textContent ?? 'branch';
      toggle.setAttribute('aria-label',(expanded ? 'Collapse ' : 'Expand ') + title);
    }
  }

  function initializeTree() {
    document.querySelectorAll('[data-tree-item][aria-expanded]').forEach(item => setTreeItemExpanded(item,false));
    let item = document.querySelector('[data-feature-id="' + CSS.escape(state.scope ?? '') + '"]')?.closest('[data-tree-item]') ?? null;
    while (item) {
      setTreeItemExpanded(item,true);
      item = item.parentElement?.closest('[data-tree-item]') ?? null;
    }
  }

  document.addEventListener('click', event => {
    const bubble = event.target.closest('.swimlane-bubble');
    if (bubble) { showSwimlaneDetail(bubble); return; }
    const mode = event.target.closest('[data-mode]');
    if (mode) { setMode(mode.dataset.mode); return; }
    const treeToggle = event.target.closest('[data-tree-toggle]');
    if (treeToggle) {
      const item = treeToggle.closest('[data-tree-item]');
      setTreeItemExpanded(item,item?.getAttribute('aria-expanded') !== 'true');
      return;
    }
    const feature = event.target.closest('[data-feature-id]');
    if (feature) {
      state.scope = feature.dataset.featureId;
      setTreeItemExpanded(feature.closest('[data-tree-item]'),true);
      setMode('feature');
      return;
    }
    const pickerToggle = event.target.closest('[data-toggle-picker]');
    if (pickerToggle) {
      const app = document.querySelector('.app');
      const collapsed = app.classList.toggle('picker-collapsed');
      pickerToggle.setAttribute('aria-expanded',String(!collapsed));
      pickerToggle.setAttribute('aria-label',collapsed ? 'Expand Delivery Tree' : 'Collapse Delivery Tree');
      return;
    }
    const date = event.target.closest('[data-date]');
    if (date) { state.scope = date.dataset.date; setMode('date'); return; }
    const openSession = event.target.closest('[data-open-session]');
    if (openSession) {
      const item = state.items?.[Number(openSession.dataset.openSession)];
      if (item?.session) openSessionView(item);
      return;
    }
    const deliveryToggle = event.target.closest('[data-toggle-delivery]');
    if (deliveryToggle) {
      const workbench = deliveryToggle.closest('.workbench');
      const collapsed = workbench.classList.toggle('delivery-collapsed');
      deliveryToggle.setAttribute('aria-expanded',String(!collapsed));
      deliveryToggle.setAttribute('aria-label',collapsed ? 'Expand commits and files' : 'Collapse commits and files');
      return;
    }
    if (event.target.closest('[data-close-session]')) {
      document.getElementById('session-view').hidden = true;
      return;
    }
    if (event.target.closest('[data-session-context]')) {
      if (!state.sessionItem) return;
      document.getElementById('continuation-context').textContent = continuationText(state.sessionItem);
      document.getElementById('continuation-backdrop').hidden = false;
      document.getElementById('continuation-close').focus();
      return;
    }
    if (event.target.closest('[data-close-continuation]:not(#continuation-backdrop)') || event.target.id === 'continuation-backdrop') document.getElementById('continuation-backdrop').hidden = true;
  });

  document.addEventListener('mouseover', event => {
    const bubble = event.target.closest?.('.swimlane-bubble');
    if (bubble) showSwimlaneDetail(bubble);
  });

  document.addEventListener('focusin', event => {
    const bubble = event.target.closest?.('.swimlane-bubble');
    if (bubble) showSwimlaneDetail(bubble);
  });

  document.addEventListener('toggle', event => {
    const details = event.target.closest?.('[data-activity-session]');
    if (!details) return;
    const workbench = details.closest('.workbench');
    workbench?.classList.toggle('activity-expanded',details.open);
    workbench?.classList.toggle('delivery-collapsed',details.open);
    const deliveryToggle = workbench?.querySelector('[data-toggle-delivery]');
    if (deliveryToggle) {
      deliveryToggle.setAttribute('aria-expanded',String(!details.open));
      deliveryToggle.setAttribute('aria-label',details.open ? 'Expand commits and files' : 'Collapse commits and files');
    }
    if (!details.open) return;
    const target = details.querySelector('[data-trace-target]');
    if (!target || target.childElementCount) return;
    const template = document.querySelector('template[data-trace-session="' + CSS.escape(details.dataset.activitySession) + '"]');
    if (template) {
      target.append(template.content.cloneNode(true));
      requestAnimationFrame(() => initializeSwimlanes(target));
    }
  }, true);

  document.addEventListener('change', event => {
    if (event.target.matches('[data-session-kind-filter], [data-session-tool-filter], [data-session-file-filter]')) applySessionFilters();
    if (event.target.matches('[data-session-jump]')) document.getElementById(event.target.value)?.scrollIntoView({ behavior:'smooth', block:'start' });
  });

  document.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-resize-lane]');
    if (!handle) return;
    const grid = handle.closest('.workbench-grid');
    const workbench = handle.closest('.workbench');
    const prompt = grid.querySelector('.prompt-lane').getBoundingClientRect();
    const delivery = grid.querySelector('.delivery-lane').getBoundingClientRect();
    state.resize = { handle, grid, workbench, kind:handle.dataset.resizeLane, startX:event.clientX, promptWidth:prompt.width, deliveryWidth:delivery.width };
    handle.classList.add('resizing');
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  document.addEventListener('pointermove', event => {
    const resize = state.resize;
    if (!resize) return;
    const gridWidth = resize.grid.getBoundingClientRect().width;
    if (resize.kind === 'prompt') {
      const next = Math.max(180,Math.min(gridWidth - resize.deliveryWidth - 330,resize.promptWidth + event.clientX - resize.startX));
      resize.workbench.style.setProperty('--prompt-width',next + 'px');
    } else {
      const next = Math.max(240,Math.min(gridWidth - resize.promptWidth - 330,resize.deliveryWidth - event.clientX + resize.startX));
      resize.workbench.style.setProperty('--delivery-width',next + 'px');
    }
  });

  document.addEventListener('pointerup', () => {
    state.resize?.handle.classList.remove('resizing');
    state.resize = null;
  });

  document.addEventListener('keydown', event => {
    const resizeHandle = event.target.closest?.('[data-resize-lane]');
    if (resizeHandle && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const workbench = resizeHandle.closest('.workbench');
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      if (resizeHandle.dataset.resizeLane === 'prompt') {
        const width = workbench.querySelector('.prompt-lane').getBoundingClientRect().width;
        workbench.style.setProperty('--prompt-width',Math.max(180,width + direction * 24) + 'px');
      } else {
        const width = workbench.querySelector('.delivery-lane').getBoundingClientRect().width;
        workbench.style.setProperty('--delivery-width',Math.max(240,width - direction * 24) + 'px');
      }
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      if (!document.getElementById('continuation-backdrop').hidden) document.getElementById('continuation-backdrop').hidden = true;
      else document.getElementById('session-view').hidden = true;
    }
  });
  initializeTree();
  setMode(state.mode);
})();

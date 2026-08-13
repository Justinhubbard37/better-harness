(() => {
  const report = JSON.parse(document.getElementById("inspector-data").textContent);
  const byNode = new Map(report.featureTree.nodes.map(node => [node.id,node]));
  const byStory = new Map(report.stories.map(story => [story.id,story]));
  const bySession = new Map(report.sessions.map(session => [session.sessionId,session]));
  const byCommit = new Map(report.commits.map(commit => [commit.hash,commit]));
  const defaultCompactCommitKinds = new Set(report.presentation?.defaultCompactCommitEvidenceKinds ?? []);
  const callsBySession = new Map(report.sessions.map(session => [session.sessionId,new Map(session.toolActivity.calls.map(call => [call.id,call]))]));
  const retainedFilePaths = new Set([
    ...report.sessions.flatMap(session => session.toolActivity.files.map(file => file.path)),
    ...report.commits.flatMap(commit => commit.files.map(file => file.path)),
  ]);
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
  const initialParams = new URLSearchParams(location.search);
  const requestedMode = initialParams.get('mode');
  const hasFeatureEvidence = report.stories.some(story => story.sessionLinks.length || story.commitHashes.length);
  const defaultMode = report.featureTree.nodes.length && hasFeatureEvidence ? 'feature' : 'date';
  const initialMode = requestedMode === 'date' || requestedMode === 'feature'
    ? requestedMode
    : defaultMode;
  const requestedScope = initialMode === 'feature' ? initialParams.get('feature') : initialParams.get('date');
  const validScope = initialMode === 'feature'
    ? byNode.has(requestedScope)
    : report.days.some(day => day.date === requestedScope);
  const state = {
    mode:initialMode,
    scope:validScope ? requestedScope : initialMode === 'feature' ? initialFeature : latestDay,
    // One focused object drives explanation. A future CompareSet must remain a
    // separate state owner and full-workspace mode rather than widening Drawer.
    selection:null,
    evidenceDrawerSuppressed:false,
    sessionTrigger:null,
    sessionItem:null,
    sessionOpen:false,
    sessionPushed:false,
    syncingHistory:false,
    sessionMode:initialParams.get('session-mode') === 'replay' ? 'replay' : 'trace',
    replayEventId:initialParams.get('replay-event'),
    replayIndexTab:'events',
    replayPlaying:false,
    replaySpeed:2,
    replayTimer:null,
    // Chart zoom is a per-session view concern, never part of the evidence
    // model, so it stays out of the selection and out of the deep link.
    zoom:new Map(),
    collapsedCards:new Set(),
    items:[],
  };
  const escape = value => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
  const formatDuration = value => Number.isFinite(value) ? (value >= 3600000 ? (value / 3600000).toFixed(1) + "h" : Math.max(1,Math.round(value / 60000)) + "m") : "unknown";
  const formatLatency = value => !Number.isFinite(value) ? "timing unavailable"
    : value < 1000 ? Math.round(value) + " ms"
      : value < 60000 ? (Math.round(value / 100) / 10) + " s"
        : (Math.round(value / 6000) / 10) + " min";
  const formatSpan = value => !Number.isFinite(value) ? "unknown"
    : value < 60000 ? Math.max(1,Math.round(value / 1000)) + "s"
      : value < 3600000 ? Math.round(value / 60000) + "m"
        : (value / 3600000).toFixed(1) + "h";
  const pad = value => String(value).padStart(2,'0');
  const formatClock = value => {
    const time = new Date(value ?? NaN);
    return Number.isNaN(time.getTime()) ? 'time unknown' : pad(time.getUTCHours()) + ':' + pad(time.getUTCMinutes()) + ' UTC';
  };
  const formatShortClock = value => {
    const time = new Date(value ?? NaN);
    return Number.isNaN(time.getTime()) ? '—' : pad(time.getUTCHours()) + ':' + pad(time.getUTCMinutes());
  };
  const formatStamp = value => {
    const time = new Date(value ?? NaN);
    return Number.isNaN(time.getTime()) ? null : pad(time.getUTCHours()) + ':' + pad(time.getUTCMinutes()) + ':' + pad(time.getUTCSeconds());
  };
  const formatTokens = usage => {
    const total = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0);
    if (!usage || total === 0) return 'token usage unavailable';
    return total >= 1000 ? (Math.round(total / 100) / 10) + 'K tokens' : total + ' tokens';
  };
  const evidence = (kind, label = kind) => '<span class="evidence ' + escape(kind) + '">' + escape(label) + '</span>';
  const isDirectCommitLink = link => link?.evidenceKind === 'explicit' || link?.evidenceKind === 'observed-commit';
  const FAMILY_COLORS = { inspect:'#4f73b6', change:'#7658b5', execute:'#64748b', verify:'#258675', coordinate:'#b27627', deliver:'#628b37', other:'#8993a2' };
  const familyColor = family => FAMILY_COLORS[family] ?? FAMILY_COLORS.other;

  // Turn vocabulary comes from one projected object so the workbench lane, the
  // Session View titlebar, and the filter counts can never disagree.
  function turnCoverageOf(session) {
    return session?.turnCoverage ?? { turnCount:session?.dialogue?.turns?.length ?? 0, shownPromptCount:session?.prompts?.length ?? 0, normalizedUserTurnCount:0, observationCount:0, truncated:false };
  }

  function coverageLabel(session) {
    if (!session) return 'no linked session';
    const coverage = turnCoverageOf(session);
    const turns = coverage.turnCount + ' turn' + (coverage.turnCount === 1 ? '' : 's');
    return coverage.truncated ? coverage.shownPromptCount + ' of ' + turns + ' shown' : turns;
  }

  function coverageTitle(session) {
    const coverage = turnCoverageOf(session);
    return coverage.turnCount + ' dialogue turns · ' + coverage.normalizedUserTurnCount
      + ' normalized user turns · ' + coverage.observationCount + ' raw prompt observations. Open Session View for every turn.';
  }

  function selectionKey(selection) {
    if (!selection) return '';
    if (selection.type === 'story') return 'story:' + selection.id;
    if (selection.type === 'session') return 'session:' + selection.sessionId;
    if (selection.type === 'turn') return 'turn:' + selection.sessionId + ':' + selection.turnIndex;
    if (selection.type === 'tool-call') return 'tool-call:' + selection.sessionId + ':' + selection.callId;
    if (selection.type === 'file') return 'file:' + selection.path;
    if (selection.type === 'commit') return 'commit:' + selection.hash;
    return '';
  }

  function selectionAttrs(selection) {
    const attrs = ['data-selectable','data-selection-type="' + escape(selection.type) + '"'];
    if (selection.id) attrs.push('data-story-id="' + escape(selection.id) + '"');
    if (selection.sessionId) attrs.push('data-session-id="' + escape(selection.sessionId) + '"');
    if (selection.turnIndex) attrs.push('data-turn-index="' + escape(selection.turnIndex) + '"');
    if (selection.callId) attrs.push('data-call-id="' + escape(selection.callId) + '"');
    if (selection.path) attrs.push('data-file-path="' + escape(selection.path) + '"');
    if (selection.hash) attrs.push('data-commit-hash="' + escape(selection.hash) + '"');
    if (selection.contextSessionId) attrs.push('data-context-session-id="' + escape(selection.contextSessionId) + '"');
    return attrs.join(' ');
  }

  function selectionFromUrl(params = new URLSearchParams(location.search)) {
    const sessionId = params.get('session');
    const session = bySession.get(sessionId);
    const requestedContext = params.get('context-session') ?? sessionId;
    const contextSessionId = bySession.has(requestedContext) ? requestedContext : null;
    const callId = params.get('call');
    if (callId && session?.toolActivity.calls.some(call => call.id === callId)) return { type:'tool-call', sessionId, callId };
    const turnIndex = Number(params.get('turn'));
    if (Number.isInteger(turnIndex) && session?.dialogue?.turns?.some(turn => turn.index === turnIndex)) return { type:'turn', sessionId, turnIndex };
    const filePath = params.get('file');
    if (filePath && retainedFilePaths.has(filePath)) return { type:'file', path:filePath, contextSessionId };
    const commitHash = params.get('commit');
    if (commitHash && byCommit.has(commitHash)) return { type:'commit', hash:commitHash, contextSessionId };
    const storyId = params.get('story');
    if (storyId && byStory.has(storyId)) return { type:'story', id:storyId };
    if (session) return { type:'session', sessionId };
    return null;
  }

  function descriptorFromElement(element) {
    if (!element) return null;
    const type = element.dataset.selectionType;
    const sessionId = element.dataset.sessionId ?? element.closest('[data-activity-session]')?.dataset.activitySession;
    if (type === 'story') return { type, id:element.dataset.storyId };
    if (type === 'session') return { type, sessionId };
    if (type === 'turn') return { type, sessionId, turnIndex:Number(element.dataset.turnIndex) };
    if (type === 'tool-call') return { type, sessionId, callId:element.dataset.callId };
    if (type === 'file') return { type, path:element.dataset.filePath, contextSessionId:element.dataset.contextSessionId ?? sessionId ?? null };
    if (type === 'commit') return { type, hash:element.dataset.commitHash, contextSessionId:element.dataset.contextSessionId ?? sessionId ?? null };
    return null;
  }

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
      const sessionLinked = new Set(rows.flatMap(row => row.session.commitLinks.filter(link => isDirectCommitLink(link) && byCommit.get(link.hash)?.day === day?.date).map(link => link.hash)));
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
      if (!item.date || (isDirectCommitLink(link) && byCommit.get(link.hash)?.day === item.date.date)) hashes.add(link.hash);
    }
    for (const hash of item.unassignedCommitHashes ?? []) hashes.add(hash);
    return [...hashes].map(hash => byCommit.get(hash)).filter(Boolean).sort((a,b) => String(b.committedAt).localeCompare(String(a.committedAt)));
  }

  function itemTitle(item) {
    const session = item.session;
    return item.story?.title
      ?? (item.date ? (session?.prompts?.[0]?.text ?? session?.locator ?? 'Commits without a linked session') : ('Activity on ' + (session?.day ?? 'unknown date')));
  }

  function promptLane(item) {
    const session = item.session;
    const prompts = session?.prompts ?? [];
    const declaredPrompt = item.story?.refs?.prompts?.[0];
    const cards = [];
    if (declaredPrompt) cards.push('<button type="button" class="intent-card declared-intent" ' + selectionAttrs({ type:'story', id:item.story.id }) + '><p>' + escape(declaredPrompt) + '</p><small>Feature Tree intent · ' + escape(item.story.evidence) + '</small></button>');
    prompts.forEach(prompt => {
      // Retained prompts are capped and de-duplicated upstream, so the card
      // links to the Turn the projection resolved, never to its array index.
      const turnIndex = Number.isInteger(prompt.turnIndex) ? prompt.turnIndex : null;
      const attrs = turnIndex ? selectionAttrs({ type:'turn', sessionId:session.sessionId, turnIndex }) : selectionAttrs({ type:'session', sessionId:session.sessionId });
      const label = turnIndex ? 'User turn ' + turnIndex : 'Retained prompt';
      cards.push('<button type="button" class="intent-card" ' + attrs + '><p>' + escape(prompt.text) + '</p><small>' + escape(label) + (prompt.timestamp ? ' · ' + escape(formatClock(prompt.timestamp)) : '') + '</small></button>');
    });
    const coverage = turnCoverageOf(session);
    const more = session && coverage.truncated
      ? '<button type="button" class="lane-more" data-open-session-for="' + escape(session.sessionId) + '">Open Session View for all ' + coverage.turnCount + ' turns</button>'
      : '';
    return '<section class="lane prompt-lane' + (cards.length ? '' : ' lane-empty') + '"><div class="lane-title"><strong>User prompts</strong><span title="' + escape(coverageTitle(session)) + '">' + escape(coverageLabel(session)) + '</span></div>' + (cards.join("") || '<div class="empty-state">No retained privacy-safe user turn for this scope.</div>') + more + '</section>';
  }

  function activityLane(item) {
    const session = item.session;
    if (!session) return '<section class="lane activity-lane lane-empty"><div class="lane-title"><strong>Normalized activity</strong><span>0 calls</span></div><div class="empty-state">A session link is required before activity can be inspected.</div></section>';
    const activity = session.toolActivity;
    if (!activity.totalCalls) return '<section class="lane activity-lane lane-empty"><div class="lane-title"><strong>Checkpoint activity</strong><span>0 calls</span></div><div class="empty-state">No normalized tool call was retained for this session.</div></section>';
    const actionCounts = new Map();
    activity.calls.forEach(call => actionCounts.set(call.actionLabel,(actionCounts.get(call.actionLabel) ?? 0) + 1));
    const rankedActions = [...actionCounts.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0,6);
    const max = Math.max(...rankedActions.map(([,count]) => count),1);
    const bars = rankedActions.map(([actionLabel,count]) => '<div class="family-row"><span title="' + escape(actionLabel) + '">' + escape(actionLabel) + '</span><div class="family-track"><div class="family-fill" style="width:' + Math.max(2,(count/max)*100) + '%"></div></div><strong>' + count + '</strong></div>').join("");
    const span = activity.timeline?.spanMs;
    const spanCopy = Number.isFinite(span) && span > 0 ? ' · ' + formatSpan(span) + ' span' : '';
    const directCommits = commitsFor(item).filter(commit => isDirectCommitLink(session.commitLinks.find(link => link.hash === commit.hash)));
    const directLinks = directCommits.map(commit => session.commitLinks.find(link => link.hash === commit.hash)).filter(Boolean);
    const linkedEditCallIds = new Set(directLinks.flatMap(link => link.linkedEditCallIds ?? []));
    const linkedEditFiles = new Set(directLinks.flatMap(link => link.linkedEditFiles ?? []));
    const committedPaths = new Set(directCommits.flatMap(commit => commit.files.map(file => file.path)));
    const pathSummary = activity.files.length + ' tool-attributed path' + (activity.files.length === 1 ? '' : 's')
      + (directCommits.length ? ' · ' + committedPaths.size + ' committed path' + (committedPaths.size === 1 ? '' : 's') : '');
    const commitBridge = linkedEditCallIds.size > 0
      ? '<p class="commit-bridge linked">' + directCommits.length + ' commit' + (directCommits.length === 1 ? '' : 's') + ' linked to ' + linkedEditCallIds.size + ' observed Edit/Write call' + (linkedEditCallIds.size === 1 ? '' : 's') + ' across ' + linkedEditFiles.size + ' exact changed path' + (linkedEditFiles.size === 1 ? '' : 's') + ' before the commit.</p>'
      : directCommits.length
        ? '<p class="commit-bridge">' + directCommits.length + ' commit' + (directCommits.length === 1 ? ' was' : 's were') + ' created in this session, but no Edit/Write path was observed before the commit. The files may have entered the session as existing workspace changes.</p>'
        : '';
    return '<section class="lane activity-lane"><div class="lane-title"><strong>Checkpoint activity</strong><span>' + pathSummary + '</span></div><div class="activity-summary"><div class="activity-total"><strong>' + activity.totalCalls + '</strong><span>calls · ' + activity.failedCalls + ' failed' + escape(spanCopy) + '</span></div><div class="family-bars">' + bars + '</div></div>' + commitBridge + '<details class="activity-details" data-activity-session="' + escape(session.sessionId) + '"><summary><span>Expand ' + activity.totalCalls + ' normalized actions</span><small>focus view</small></summary><div class="activity-actions"><button type="button" class="activity-action" ' + selectionAttrs({ type:'session', sessionId:session.sessionId }) + '>Open detail</button><button type="button" class="activity-action primary" data-open-session-for="' + escape(session.sessionId) + '">Open session</button></div><div class="trace-target" data-activity-chart="' + escape(session.sessionId) + '"></div></details></section>';
  }

  function fileTree(commit, link) {
    const overlap = new Set(link?.overlappingFiles ?? []);
    const linkedEdits = new Set(link?.linkedEditFiles ?? []);
    const groups = new Map();
    for (const file of commit.files) {
      const parts = file.path.split('/');
      const folder = parts.length > 1 ? parts.shift() : '(root)';
      if (!groups.has(folder)) groups.set(folder,[]);
      groups.get(folder).push({ ...file, display:parts.join('/') || file.path });
    }
    return [...groups.entries()].map(([folder,files]) => '<div class="folder">' + escape(folder) + '</div>' + files.map(file => {
      const editedBeforeCommit = linkedEdits.has(file.path);
      const shared = overlap.has(file.path);
      const sharedKind = editedBeforeCommit ? 'observed-commit' : link?.evidenceKind === 'file-context' ? 'file-context' : 'observed-overlap';
      const sharedLabel = editedBeforeCommit ? 'edited before commit' : link?.evidenceKind === 'file-context' ? 'same path' : 'observed same-path';
      const fileSelection = { type:'file', path:file.path, contextSessionId:link?.sessionId ?? null };
      return '<button type="button" class="file-row" ' + selectionAttrs(fileSelection) + '><code title="' + escape(file.path) + '">' + escape(file.display) + '</code><span class="delta">' + (Number.isFinite(file.added) ? '+' + file.added : 'bin') + ' / ' + (Number.isFinite(file.removed) ? '-' + file.removed : 'bin') + ' ' + evidence(editedBeforeCommit || shared ? sharedKind : 'commit-change', editedBeforeCommit || shared ? sharedLabel : 'commit') + '</span></button>';
    }).join('')).join('');
  }

  function commitLaneContext(item, commit) {
    const link = item.session?.commitLinks?.find(candidate => candidate.hash === commit.hash) ?? null;
    const kind = link?.evidenceKind ?? (item.story?.commitHashes?.includes(commit.hash) ? item.story.evidence : 'contextual');
    return { link, kind, compact:defaultCompactCommitKinds.has(kind) };
  }

  function deliveryLane(item, commits) {
    const commitContexts = commits.map(commit => ({ commit, ...commitLaneContext(item,commit) }));
    const compactCount = commitContexts.filter(context => context.compact).length;
    const cards = commitContexts.map(({ commit, link, kind, compact }) => {
      const label = kind === 'file-context' ? 'same-file history' : kind === 'observed-overlap' ? 'observed same-path' : kind === 'observed-commit' ? 'created in session' : kind;
      const relation = link ? (link.evidenceKind === 'file-context' ? ' · same-file context' : link.evidenceKind === 'observed-commit' ? ' · observed commit action' : ' · ' + escape(link.confidence) + ' correlation') : '';
      const contextSessionId = item.session?.sessionId ?? null;
      const linked = link ? { ...link, sessionId:contextSessionId } : null;
      const stats = commit.fileCount + ' files · +' + commit.linesAdded + ' / -' + commit.linesRemoved + relation;
      const files = '<div class="file-tree">' + (fileTree(commit,linked) || '<div class="empty-state">No changed paths retained.</div>') + '</div>';
      if (compact) {
        return '<details class="commit-card commit-card-compact"><summary class="commit-head" ' + selectionAttrs({ type:'commit', hash:commit.hash, contextSessionId }) + '><div class="commit-head-line compact"><span class="commit-chevron" aria-hidden="true">›</span><code>' + escape(commit.shortHash) + '</code><span class="commit-subject" title="' + escape(commit.subject) + '">' + escape(commit.subject) + '</span><span class="commit-stats">' + stats + '</span>' + evidence(kind,label) + '</div></summary>' + files + '</details>';
      }
      return '<details class="commit-card commit-card-expanded" open><summary class="commit-head" ' + selectionAttrs({ type:'commit', hash:commit.hash, contextSessionId }) + '><div class="commit-head-line"><span class="commit-id"><span class="commit-chevron" aria-hidden="true">›</span><code>' + escape(commit.shortHash) + '</code></span>' + evidence(kind,label) + '</div><p>' + escape(commit.subject) + '</p><div class="commit-stats">' + stats + '</div></summary>' + files + '</details>';
    }).join('');
    if (!commits.length) return '<section class="lane delivery-lane lane-empty"><div class="lane-title"><div class="delivery-title-copy"><strong>Commits / files</strong><span>0 commits</span></div></div><div class="empty-state">No commit is linked to this session or Story.</div></section>';
    const compactLabel = compactCount ? ' · ' + compactCount + ' compact' : '';
    return '<section class="lane delivery-lane"><div class="lane-title"><div class="delivery-title-copy"><strong>Commits / files</strong><span>' + commits.length + ' commits' + compactLabel + '</span></div><button class="delivery-toggle" data-toggle-delivery aria-expanded="true" aria-label="Collapse commits and files"><span class="open-label">Hide</span><span class="closed-label">Show files</span></button></div><div class="delivery-content">' + cards + '</div></section>';
  }

  function setDeliveryCollapsed(workbench, collapsed) {
    if (!workbench) return;
    workbench.classList.toggle('delivery-collapsed',collapsed);
    const toggle = workbench.querySelector('[data-toggle-delivery]');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded',String(!collapsed));
    toggle.setAttribute('aria-label',collapsed ? 'Expand commits and files' : 'Collapse commits and files');
  }

  function workbench(item,index) {
    const commits = commitsFor(item);
    const session = item.session;
    const title = itemTitle(item);
    const kicker = item.story?.featureTitle ?? (item.date ? (session ? 'Session · ' + formatClock(session.firstSeen) : 'Unlinked commits') : 'Unmapped');
    const sessionMeta = session ? session.locator + ' · ' + formatDuration(session.durationMs) : 'No linked session';
    const sessionAction = session ? '<button class="prepare-button" data-open-session="' + escape(session.sessionId) + '">Open session</button>' : '';
    const headerSelection = session
      ? { type:'session', sessionId:session.sessionId }
      : item.story ? { type:'story', id:item.story.id } : null;
    const header = headerSelection
      ? '<button type="button" class="workbench-object-select" ' + selectionAttrs(headerSelection) + '><small>' + escape(kicker) + '</small><h3>' + escape(title) + '</h3><div class="meta">' + escape(sessionMeta) + '</div></button>'
      : '<div><small>' + escape(kicker) + '</small><h3>' + escape(title) + '</h3><div class="meta">' + escape(sessionMeta) + '</div></div>';
    const collapsed = state.collapsedCards.has(index);
    const collapseToggle = '<button class="card-collapse" type="button" data-toggle-card="' + index + '" aria-expanded="' + String(!collapsed) + '" aria-label="' + (collapsed ? 'Expand' : 'Collapse') + ' this workbench">' + (collapsed ? '+' : '−') + '</button>';
    return '<article class="workbench' + (collapsed ? ' card-collapsed' : '') + '" id="workbench-card-' + index + '" data-workbench="' + index + '" data-session-context="' + escape(session?.sessionId ?? '') + '"><header class="workbench-head">' + header + '<div class="head-actions">' + evidence(item.link.evidenceKind) + sessionAction + collapseToggle + '</div></header><div class="workbench-grid">' + promptLane(item) + '<div class="lane-resizer prompt" data-resize-lane="prompt" role="separator" aria-orientation="vertical" aria-label="Resize prompt and activity lanes" tabindex="0"></div>' + activityLane(item) + '<div class="lane-resizer delivery" data-resize-lane="delivery" role="separator" aria-orientation="vertical" aria-label="Resize activity and delivery lanes" tabindex="0"></div>' + deliveryLane(item,commits) + '</div></article>';
  }

  function continuationText(item) {
    const commits = commitsFor(item);
    const lines = ['Harness Inspector continuation context (read-only)',''];
    if (item.story) lines.push('Story: ' + item.story.title + ' [' + item.story.id + ']','Story evidence: ' + item.story.evidence);
    if (item.session) lines.push('Session locator: ' + item.session.locator,'Session window: ' + (item.session.firstSeen ?? 'unknown') + ' — ' + (item.session.lastSeen ?? 'unknown'),'Dialogue turns: ' + turnCoverageOf(item.session).turnCount,'Normalized tool calls: ' + item.session.toolActivity.totalCalls);
    if (item.session?.prompts?.length) lines.push('','Retained user turns:',...item.session.prompts.map(prompt => '- ' + (prompt.turnIndex ? 'Turn ' + prompt.turnIndex : 'unplaced') + '. ' + prompt.text));
    if (commits.length) lines.push('','Commits:',...commits.map(commit => '- ' + commit.shortHash + ' ' + commit.subject));
    const overlaps = commits.flatMap(commit => item.session?.commitLinks?.find(link => link.hash === commit.hash)?.overlappingFiles ?? []);
    if (overlaps.length) lines.push('','Exact shared paths (context only unless the commit link is explicit/correlated):',...[...new Set(overlaps)].map(file => '- ' + file));
    lines.push('','Boundary: this context does not restore code, mutate Git/workspace state, or resume a native Codex session.');
    return lines.join('\\n');
  }

  // ---------------------------------------------------------------- activity chart

  function chartLanes(activity, maxLanes = 7) {
    const counts = new Map();
    const firstStep = new Map();
    for (const call of activity.calls) {
      const label = String(call.actionLabel ?? call.toolName ?? 'Use tool');
      counts.set(label,(counts.get(label) ?? 0) + 1);
      if (!firstStep.has(label)) firstStep.set(label,call.step);
    }
    const ranked = [...counts.keys()].sort((left,right) => counts.get(right) - counts.get(left) || firstStep.get(left) - firstStep.get(right) || left.localeCompare(right));
    const laneLimit = Math.max(2,maxLanes);
    const visibleCount = ranked.length > laneLimit ? laneLimit - 1 : laneLimit;
    const visible = new Set(ranked.slice(0,visibleCount));
    const lanes = ranked.slice(0,visibleCount).map(label => ({ label, title:label, count:counts.get(label) }));
    if (ranked.length > visibleCount) {
      const rest = ranked.slice(visibleCount);
      lanes.push({
        label:'Other activity',
        title:'Other activity: ' + rest.slice(0,6).join(', ') + (rest.length > 6 ? ' and more' : ''),
        count:rest.reduce((sum,label) => sum + counts.get(label),0),
      });
    }
    return { lanes, laneFor:call => visible.has(String(call.actionLabel ?? call.toolName)) ? String(call.actionLabel ?? call.toolName) : 'Other activity' };
  }

  function chartDomain(activity, zoom) {
    const timeline = activity.timeline ?? {};
    const timeBasis = timeline.basis === 'observed-time'
      && Number.isFinite(timeline.startMs)
      && Number.isFinite(timeline.endMs)
      && timeline.endMs > timeline.startMs;
    const fullMin = timeBasis ? timeline.startMs : 1;
    const fullMax = timeBasis ? timeline.endMs : Math.max(1,...activity.calls.map(call => call.step),1);
    const width = Math.max(1,fullMax - fullMin);
    return {
      timeBasis,
      fullMin,
      fullMax,
      min: zoom ? fullMin + width * zoom.from : fullMin,
      max: zoom ? fullMin + width * zoom.to : fullMax,
    };
  }

  const callPosition = (call, timeBasis) => timeBasis
    ? (Number.isFinite(call.startedAt) ? call.startedAt : null)
    : call.step;

  function activityChartMarkup(session, availableWidth, { compact = false } = {}) {
    const activity = session.toolActivity;
    if (!activity.totalCalls) return '<div class="chart-empty">No normalized tool call was retained for this session.</div>';
    const zoom = state.zoom.get(session.sessionId) ?? null;
    const domain = chartDomain(activity,zoom);
    const { lanes, laneFor } = chartLanes(activity,compact ? 4 : 7);
    const laneIndex = new Map(lanes.map((lane,index) => [lane.label,index]));
    const untimed = domain.timeBasis ? activity.calls.filter(call => !Number.isFinite(call.startedAt)).length : 0;
    const inDomain = activity.calls.filter(call => {
      const position = callPosition(call,domain.timeBasis);
      return position !== null && position >= domain.min && position <= domain.max;
    });
    const commitEvents = domain.timeBasis ? session.commitLinks
      .filter(isDirectCommitLink)
      .map(link => ({ link, commit:byCommit.get(link.hash) }))
      .map(item => ({ ...item, position:new Date(item.commit?.committedAt ?? item.commit?.authoredAt ?? NaN).getTime() }))
      .filter(item => item.commit && Number.isFinite(item.position) && item.position >= domain.min && item.position <= domain.max)
      .sort((left,right) => left.position - right.position) : [];

    const labelWidth = compact ? 88 : 132;
    const rowHeight = compact ? 18 : 26;
    // The ribbon fills the whole observed span with no holes, so the time
    // between calls stays visible instead of reading as blank canvas. It only
    // makes sense against real clock time; on the call-order fallback the
    // spacing would be an artefact of ordinal position, so it is omitted.
    const showRibbon = domain.timeBasis;
    const ribbonTop = compact ? 4 : 8;
    const ribbonHeight = compact ? 12 : 22;
    const topPad = showRibbon ? ribbonTop + ribbonHeight + (compact ? 8 : 14) : (compact ? 4 : 8);
    const width = Math.max(300,Math.floor(availableWidth || 640));
    const plotLeft = labelWidth + 12;
    const plotRight = width - (compact ? 8 : 14);
    const plotWidth = Math.max(60,plotRight - plotLeft);
    const laneArea = topPad + lanes.length * rowHeight + 4;
    const height = laneArea + (compact ? 22 : 30);
    const domainWidth = Math.max(1,domain.max - domain.min);
    const timelineScale = buildCompressedTimelineScale({
      min:domain.min,
      max:domain.max,
      positions:inDomain.map(call => callPosition(call,domain.timeBasis)),
      plotLeft,
      plotWidth,
      timeBasis:domain.timeBasis,
    });
    const xFor = timelineScale.xFor;
    const laneTop = index => topPad + index * rowHeight;
    const laneCenter = index => laneTop(index) + rowHeight / 2;

    const binPx = 5;
    const binCount = Math.max(1,Math.min(600,Math.floor(plotWidth / binPx)));
    const binOf = position => Math.min(binCount - 1,Math.max(0,Math.floor(timelineScale.visualFractionFor(position) * binCount)));
    const bins = new Map();
    for (const call of inDomain) {
      const position = callPosition(call,domain.timeBasis);
      const lane = laneIndex.get(laneFor(call)) ?? 0;
      const index = binOf(position);
      const key = lane + ':' + index;
      const bin = bins.get(key) ?? { lane, index, count:0, failed:0, ids:[], min:position, max:position, family:call.family };
      bin.count += 1;
      if (call.status === 'failed') bin.failed += 1;
      if (bin.ids.length < 400) bin.ids.push(call.id);
      bin.min = Math.min(bin.min,position);
      bin.max = Math.max(bin.max,position);
      bins.set(key,bin);
    }
    const maxBin = Math.max(1,...[...bins.values()].map(bin => bin.count));
    // Individual marks only survive while every bin holds one call. Above that
    // the lane switches to counted bars, so no call is hidden under another.
    const detailMode = maxBin <= 1;

    const laneMarkup = lanes.map((lane,index) => {
      const label = [...lane.label].length > 18 ? [...lane.label].slice(0,17).join('') + '…' : lane.label;
      const alt = index % 2 ? '<rect class="chart-row-alt" x="' + labelWidth + '" y="' + laneTop(index) + '" width="' + (width - labelWidth) + '" height="' + rowHeight + '"></rect>' : '';
      return '<g class="chart-lane" data-action-lane="' + escape(lane.label) + '">' + alt
        + '<line class="chart-lane-line" x1="' + (plotLeft - 6) + '" x2="' + (plotRight + 6) + '" y1="' + (laneTop(index) + rowHeight - 3) + '" y2="' + (laneTop(index) + rowHeight - 3) + '"></line>'
        + '<text class="chart-lane-label" x="' + (labelWidth - 10) + '" y="' + (laneCenter(index) + 3) + '" text-anchor="end"><title>' + escape(lane.title + ' · ' + lane.count + ' calls') + '</title>' + escape(label) + '</text></g>';
    }).join('');

    // Idle stretches are the point of a time axis: shade any window where the
    // session produced no observed call so waiting is visible, not inferred.
    // The threshold tracks the span loosely enough that real waits still
    // qualify — keyed off the span alone, a busy session reported no idle at all.
    let gapMarkup = '';
    let longestGap = null;
    if (domain.timeBasis && inDomain.length > 1) {
      const positions = inDomain.map(call => callPosition(call,true)).sort((left,right) => left - right);
      const threshold = Math.max(45000,domainWidth / 120);
      for (let index = 1; index < positions.length; index += 1) {
        const gap = positions[index] - positions[index - 1];
        if (gap < threshold) continue;
        if (!longestGap || gap > longestGap.gap) longestGap = { gap, at:positions[index - 1] };
        const gapStart = positions[index - 1];
        const gapEnd = positions[index];
        const compressed = timelineScale.gaps.some(candidate => candidate.from === gapStart && candidate.to === gapEnd);
        const left = xFor(gapStart);
        const right = Math.max(xFor(positions[index]),left + 3);
        const caption = 'No observed call for ' + formatSpan(gap) + ' (' + formatShortClock(gapStart) + ' → ' + formatShortClock(gapEnd) + ' UTC)' + (compressed ? '. This idle window is visually compressed.' : '');
        const label = compressed
          ? '<text class="chart-gap-label" x="0" y="0" transform="translate(' + ((left + right) / 2) + ' ' + (laneArea - 9) + ') rotate(-90)" text-anchor="start">idle ' + escape(formatSpan(gap)) + ' · compressed</text>'
          : right - left > 46
            ? '<text class="chart-gap-label" x="' + ((left + right) / 2) + '" y="' + (topPad + 10) + '" text-anchor="middle">idle ' + escape(formatSpan(gap)) + '</text>'
            : '';
        const breakMark = compressed
          ? '<path class="chart-gap-break" d="M ' + (((left + right) / 2) - 7) + ' ' + (laneArea - 4) + ' l 4 -4 l 4 4 l 4 -4 l 4 4"></path>'
          : '';
        gapMarkup += '<g class="chart-gap' + (compressed ? ' compressed' : '') + '"><rect x="' + left + '" y="' + topPad + '" width="' + (right - left) + '" height="' + (laneArea - topPad) + '"><title>' + escape(caption) + '</title></rect>' + label + breakMark + '</g>';
      }
    }

    // The base band is the span itself; every observed call is painted over it,
    // so whatever stays bare is time this session did not spend inside a tool.
    // That residue is labelled as unattributed, never as a model turn: the host
    // timestamps calls, not the model's own work, and the projection drops the
    // note stamps that would be needed to claim otherwise.
    let ribbonMarkup = '';
    if (showRibbon) {
      const ribbonMid = ribbonTop + ribbonHeight / 2;
      const blocks = inDomain.map(call => {
        const position = callPosition(call,true);
        const timed = call.durationStatus === 'observed' && Number.isFinite(call.durationMs);
        const left = xFor(position);
        const blockWidth = timed
          ? Math.max(1.5,Math.min(plotLeft + plotWidth - left,timelineScale.durationWidth(position,call.durationMs)))
          : 1.5;
        const failed = call.status === 'failed';
        const stamp = formatStamp(call.startedAt);
        const label = call.id + ' · ' + (call.actionLabel ?? call.toolName) + ' · ' + call.toolName
          + (stamp ? ' · ' + stamp + ' UTC' : '')
          + ' · ' + (timed ? formatLatency(call.durationMs) : 'timing unavailable')
          + (failed ? ' · failed' : '');
        return '<rect class="chart-ribbon-block' + (failed ? ' failed' : '') + '" ' + selectionAttrs({ type:'tool-call', sessionId:session.sessionId, callId:call.id })
          + ' data-chart-detail="' + escape(label) + '"'
          + ' x="' + left + '" y="' + ribbonTop + '" width="' + blockWidth + '" height="' + ribbonHeight + '"'
          + ' fill="' + (failed ? '#c34f4f' : familyColor(call.family)) + '"'
          + ' tabindex="0" role="button" aria-label="' + escape(label) + '"><title>' + escape(label) + '</title></rect>';
      }).join('');
      const toolMs = inDomain.reduce((sum,call) => sum + (call.durationStatus === 'observed' && Number.isFinite(call.durationMs) ? call.durationMs : 0),0);
      const baseLabel = 'Full observed span. Coloured blocks are observed tool calls; bare band is time not attributed to any tool call — model work or waiting the host did not separately observe.';
      ribbonMarkup = '<g class="chart-ribbon">'
        + '<rect class="chart-ribbon-base" x="' + plotLeft + '" y="' + ribbonTop + '" width="' + plotWidth + '" height="' + ribbonHeight + '" rx="3"><title>' + escape(baseLabel) + '</title></rect>'
        + blocks
        + '<text class="chart-lane-label chart-ribbon-label" x="' + (labelWidth - 10) + '" y="' + (ribbonMid + 3) + '" text-anchor="end"><title>' + escape('Observed tool time ' + formatSpan(toolMs) + ' of ' + formatSpan(domain.max - domain.min) + ' in view') + '</title>All activity</text>'
        + '</g>';
    }

    let marksMarkup = '';
    if (detailMode) {
      marksMarkup = inDomain.map(call => {
        const position = callPosition(call,domain.timeBasis);
        const lane = laneIndex.get(laneFor(call)) ?? 0;
        const timed = call.durationStatus === 'observed' && Number.isFinite(call.durationMs);
        const markWidth = domain.timeBasis && timed
          ? Math.max(3,Math.min(plotWidth,timelineScale.durationWidth(position,call.durationMs)))
          : 4;
        const failed = call.status === 'failed';
        const tone = failed ? '#c34f4f' : familyColor(call.family);
        const stamp = formatStamp(call.startedAt);
        const label = call.id + ' · ' + (call.actionLabel ?? call.toolName) + ' · ' + call.toolName
          + (stamp ? ' · ' + stamp + ' UTC' : '')
          + ' · ' + (failed ? 'failed' : 'observed') + ' · ' + (timed ? formatLatency(call.durationMs) : 'timing unavailable')
          + (call.detail ? ' · ' + call.detail : '')
          + (call.filePaths?.length ? ' · ' + call.filePaths.join(' · ') : '');
        const markHeight = compact ? 8 : 10;
        return '<rect class="chart-mark' + (failed ? ' failed' : '') + '" ' + selectionAttrs({ type:'tool-call', sessionId:session.sessionId, callId:call.id })
          + ' data-chart-detail="' + escape(label) + '"'
          + ' x="' + xFor(position) + '" y="' + (laneCenter(lane) - markHeight / 2) + '" width="' + markWidth + '" height="' + markHeight + '" rx="2"'
          + ' fill="' + (timed || failed ? tone : '#ffffff') + '" stroke="' + tone + '" stroke-width="' + (timed || failed ? 1 : 1.5) + '"'
          + ' tabindex="0" role="button" aria-label="' + escape(label) + '"><title>' + escape(label) + '</title></rect>';
      }).join('');
    } else {
      marksMarkup = [...bins.values()].map(bin => {
        const barHeight = 4 + Math.sqrt(bin.count / maxBin) * (rowHeight - 11);
        const top = laneTop(bin.lane) + rowHeight - 3 - barHeight;
        const tone = bin.failed > 0 ? '#c34f4f' : familyColor(bin.family);
        const slice = domain.timeBasis
          ? formatShortClock(bin.min) + '–' + formatShortClock(bin.max) + ' UTC'
          : 'calls ' + Math.round(bin.min) + '–' + Math.round(bin.max);
        const label = bin.count + ' call' + (bin.count === 1 ? '' : 's') + ' · ' + lanes[bin.lane].label + ' · ' + slice + (bin.failed ? ' · ' + bin.failed + ' failed' : '');
        return '<rect class="chart-bin' + (bin.failed ? ' failed' : '') + '" data-chart-bin data-bin-from="' + bin.min + '" data-bin-to="' + bin.max + '" data-bin-count="' + bin.count + '" data-session-id="' + escape(session.sessionId) + '" data-call-id="' + escape(bin.ids[0]) + '" data-chart-detail="' + escape(label) + '"'
          + ' x="' + xFor(bin.min) + '" y="' + top + '" width="' + Math.max(2,binPx - 1) + '" height="' + barHeight + '" rx="1" fill="' + tone + '"'
          + ' tabindex="0" role="button" aria-label="' + escape(label) + '"><title>' + escape(label) + '</title></rect>';
      }).join('');
    }

    const commitMarkup = commitEvents.map(({ commit, link, position }) => {
      const linkedCalls = link.linkedEditCallIds?.length ?? 0;
      const linkedPaths = link.linkedEditFiles?.length ?? 0;
      const association = linkedCalls
        ? linkedCalls + ' linked Edit/Write call' + (linkedCalls === 1 ? '' : 's') + ' across ' + linkedPaths + ' exact changed path' + (linkedPaths === 1 ? '' : 's')
        : 'no linked Edit/Write path observed before this commit';
      const label = 'Commit ' + commit.shortHash + ' · ' + commit.subject + ' · ' + formatShortClock(position) + ' UTC · ' + association;
      const x = xFor(position);
      const markerY = topPad + 7;
      return '<line class="chart-commit-line" x1="' + x + '" x2="' + x + '" y1="' + (markerY + 5) + '" y2="' + laneArea + '"></line>'
        + '<path class="chart-commit chart-commit-marker" ' + selectionAttrs({ type:'commit', hash:commit.hash, contextSessionId:session.sessionId })
        + ' data-chart-detail="' + escape(label) + '" d="M ' + x + ' ' + (markerY - 5) + ' L ' + (x + 5) + ' ' + markerY + ' L ' + x + ' ' + (markerY + 5) + ' L ' + (x - 5) + ' ' + markerY + ' Z"'
        + ' tabindex="0" role="button" aria-label="' + escape(label) + '"><title>' + escape(label) + '</title></path>';
    }).join('');

    const tickCount = Math.max(2,Math.min(7,Math.floor(plotWidth / 92)));
    const ticks = Array.from({ length:tickCount },(_,index) => plotLeft + (plotWidth * index) / (tickCount - 1));
    const tickMarkup = ticks.map(x => {
      const position = timelineScale.positionForX(x);
      return '<g><line class="chart-grid-line" x1="' + x + '" x2="' + x + '" y1="' + topPad + '" y2="' + laneArea + '"></line><text class="chart-tick" x="' + x + '" y="' + (laneArea + (compact ? 14 : 17)) + '" text-anchor="middle">' + escape(domain.timeBasis ? formatShortClock(position) : String(Math.round(position))) + '</text></g>';
    }).join('');

    const basisNote = domain.timeBasis
      ? (timelineScale.compressed ? 'Wall-clock timestamps; long idle windows are visually compressed and bar height counts calls in that slice.' : 'Wall-clock time; bar height counts calls in that slice.')
      : 'No observed call timing in this session; the axis falls back to call order.';
    const aria = activity.totalCalls + ' normalized tool calls by action over ' + (domain.timeBasis ? 'observed time, with ' + commitEvents.length + ' commit events in view' : 'call sequence');

    return '<section class="chart-card' + (compact ? ' chart-compact' : '') + '" aria-label="NormalizedToolActivityV1 provider-neutral actions">'
      + '<div class="chart-toolbar"><span class="chart-basis' + (domain.timeBasis ? '' : ' fallback') + '">' + escape(domain.timeBasis ? (timelineScale.compressed ? 'Time axis · idle compressed' : 'Time axis') : 'Sequence axis (no observed timing)') + '</span>'
      + '<span class="chart-range">' + escape(domain.timeBasis ? formatShortClock(domain.min) + ' → ' + formatShortClock(domain.max) + ' UTC · ' + formatSpan(domain.max - domain.min) : 'calls ' + Math.round(domain.min) + '–' + Math.round(domain.max)) + '</span>'
      + '<button type="button" class="chart-reset" data-chart-reset="' + escape(session.sessionId) + '"' + (zoom ? '' : ' disabled') + '>Reset zoom</button></div>'
      + '<svg class="activity-chart" data-activity-svg="' + escape(session.sessionId) + '" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escape(aria) + '">'
      + '<title>' + escape(aria) + '</title><desc>' + escape(basisNote + ' Shaded columns are windows with no observed call. Compressed idle windows retain their real UTC duration and use a broken scale. Red marks are failed calls. Green diamonds mark directly linked commit times. Drag across the plot to zoom.') + '</desc>'
      + '<rect class="chart-surface" data-chart-surface x="' + plotLeft + '" y="' + topPad + '" width="' + plotWidth + '" height="' + (laneArea - topPad) + '" data-plot-left="' + plotLeft + '" data-plot-width="' + plotWidth + '" data-domain-min="' + domain.min + '" data-domain-max="' + domain.max + '" data-full-min="' + domain.fullMin + '" data-full-max="' + domain.fullMax + '" data-axis-segments="' + escape(JSON.stringify(timelineScale.segments)) + '" data-session-id="' + escape(session.sessionId) + '"></rect>'
      + laneMarkup + gapMarkup + tickMarkup + ribbonMarkup + marksMarkup + commitMarkup
      + '<rect class="chart-brush" data-chart-brush x="0" y="' + topPad + '" width="0" height="' + (laneArea - topPad) + '" hidden></rect>'
      + '<line class="chart-axis-line" x1="' + labelWidth + '" x2="' + (plotRight + 6) + '" y1="' + laneArea + '" y2="' + laneArea + '"></line>'
      + '<text class="chart-axis-label" x="' + (labelWidth - 10) + '" y="' + (laneArea + (compact ? 14 : 17)) + '" text-anchor="end">' + escape(domain.timeBasis ? 'UTC' : 'Call') + '</text>'
      + '</svg>'
      + '<div class="chart-inspector" data-chart-inspector aria-live="polite"><strong>Hover, focus, or click an event</strong><span>' + escape((detailMode ? 'Each action mark is one call; its width is the observed latency.' : 'Each action bar counts calls in a time slice — click to zoom in until individual calls appear.') + (commitEvents.length ? ' Green diamonds open Commit evidence.' : '')) + '</span></div>'
      + '<footer class="chart-legend"><span>' + inDomain.length + ' of ' + activity.totalCalls + ' calls in view</span>'
      + (longestGap ? '<span>longest idle ' + escape(formatSpan(longestGap.gap)) + ' at ' + escape(formatShortClock(longestGap.at)) + ' UTC</span>' : '')
      + (untimed ? '<span class="chart-warning">' + untimed + ' without observed timing</span>' : '')
      + (showRibbon ? '<span><i class="legend-dot between"></i>between calls (unattributed — model work or wait)</span>' : '')
      + '<span><i class="legend-dot failed"></i>failed</span><span><i class="legend-dot gap"></i>idle window (no observed call, not user wait)</span>'
      + (domain.timeBasis ? '<span><i class="legend-dot commit"></i>directly linked commit</span>' : '')
      + '<span>' + escape(basisNote) + '</span></footer></section>';
  }

  function renderActivityChart(container) {
    const session = bySession.get(container.dataset.activityChart);
    if (!session || !container.clientWidth) return;
    container.innerHTML = activityChartMarkup(session,container.clientWidth,{ compact:Boolean(container.closest('.session-axis-panel')) });
    applySelectionPresentation();
  }

  const chartObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => entries.forEach(entry => {
      if (entry.target.dataset.activityChart) renderActivityChart(entry.target);
    }))
    : null;

  function showChartDetail(element) {
    const inspector = element.closest('.chart-card')?.querySelector('[data-chart-inspector]');
    if (!inspector || !element.dataset.chartDetail) return;
    const hint = element.hasAttribute('data-chart-bin') ? 'Click to zoom into this slice.' : 'Click to explain it in the Evidence Drawer.';
    inspector.innerHTML = '<strong>' + escape(element.dataset.chartDetail) + '</strong><span>' + escape(hint) + '</span>';
  }

  function chartPositionAt(surface, x) {
    const plotLeft = Number(surface.dataset.plotLeft);
    const plotWidth = Math.max(1,Number(surface.dataset.plotWidth));
    const ratio = (Math.min(plotLeft + plotWidth,Math.max(plotLeft,x)) - plotLeft) / plotWidth;
    try {
      const segments = JSON.parse(surface.dataset.axisSegments ?? '[]');
      const visualSpan = Number(segments.at(-1)?.visualTo);
      if (segments.length && Number.isFinite(visualSpan) && visualSpan > 0) {
        const visual = ratio * visualSpan;
        const segment = segments.find(candidate => visual <= candidate.visualTo) ?? segments.at(-1);
        const within = (visual - segment.visualFrom) / Math.max(Number.EPSILON,segment.visualTo - segment.visualFrom);
        return segment.from + within * (segment.to - segment.from);
      }
    } catch { /* Fall back to the linear report contract below. */ }
    const domainMin = Number(surface.dataset.domainMin);
    return domainMin + ratio * (Number(surface.dataset.domainMax) - domainMin);
  }

  function setZoom(sessionId, from, to) {
    if (to - from >= 0.999) state.zoom.delete(sessionId);
    else state.zoom.set(sessionId,{ from:Math.max(0,from), to:Math.min(1,Math.max(from + 0.0005,to)) });
    document.querySelectorAll('[data-activity-chart="' + CSS.escape(sessionId) + '"]').forEach(renderActivityChart);
  }

  // ---------------------------------------------------------------- session view

  const commitTime = commit => new Date(commit.committedAt ?? commit.authoredAt ?? 0).getTime();

  // A commit only joins a Turn when its timestamp falls inside that Turn's
  // observed window. Everything else stays in an explicit outside-the-window
  // track, so layout never implies a Turn produced a commit it predates.
  function placeCommits(commits, turns, session) {
    const inTurn = new Map();
    const outside = [];
    const sessionStart = new Date(session.firstSeen ?? NaN).getTime();
    const sessionEnd = new Date(session.lastSeen ?? NaN).getTime();
    for (const commit of commits) {
      const time = commitTime(commit);
      const turn = turns.find(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && time >= item.startMs && time <= item.endMs);
      if (turn) {
        const bucket = inTurn.get(turn.index) ?? [];
        bucket.push(commit);
        inTurn.set(turn.index,bucket);
        continue;
      }
      const relation = Number.isFinite(sessionStart) && time < sessionStart ? 'before this session started'
        : Number.isFinite(sessionEnd) && time > sessionEnd ? 'after this session ended'
          : 'between observed turn windows';
      outside.push({ commit, relation });
    }
    return { inTurn, outside };
  }

  // Long traces repeat the same redacted row many times over. Collapsing an
  // identical consecutive run keeps every call addressable while removing the
  // rows a reviewer has no way to tell apart.
  function toolRuns(calls) {
    const runs = [];
    for (const call of calls) {
      const key = [call.actionLabel,call.toolName,call.status,call.detail ?? '',(call.filePaths ?? []).join(',')].join('|');
      const current = runs.at(-1);
      if (current && current.key === key) current.calls.push(call);
      else runs.push({ key, calls:[call] });
    }
    return runs;
  }

  function toolRowMarkup(session, call) {
    const stamp = formatStamp(call.startedAt);
    return '<button type="button" class="session-tool-row" data-session-tool-row data-tool="' + escape(call.toolName) + '" id="session-call-' + escape(call.id) + '" ' + selectionAttrs({ type:'tool-call', sessionId:session.sessionId, callId:call.id }) + '>'
      + '<span class="session-tool-id">' + escape(call.id) + '</span>'
      + '<span class="session-tool-copy"><strong>' + escape(call.actionLabel) + '</strong><code title="' + escape(call.toolName) + '">' + escape(call.toolName) + '</code>' + (call.status === 'failed' ? '<em class="session-tool-failed">failed</em>' : '') + '</span>'
      + '<span class="session-tool-time"><code>' + escape(stamp ?? '—') + '</code><small>' + escape(call.durationStatus === 'observed' ? formatLatency(call.durationMs) : '—') + '</small></span>'
      + (call.detail ? '<code class="session-tool-detail">' + escape(call.detail) + '</code>' : '')
      + (call.filePaths?.length ? '<code class="session-tool-file">' + escape(call.filePaths.join(' · ')) + '</code>' : '')
      + '</button>';
  }

  function toolListMarkup(session, calls) {
    const blocks = toolRuns(calls).map((run,index) => {
      if (run.calls.length === 1) return toolRowMarkup(session,run.calls[0]);
      const first = run.calls[0];
      const last = run.calls.at(-1);
      const total = run.calls.reduce((sum,call) => sum + (call.durationStatus === 'observed' ? call.durationMs : 0),0);
      return '<details class="session-tool-run" data-tool="' + escape(first.toolName) + '" data-call-count="' + run.calls.length + '" id="' + escape(session.sessionId + '-run-' + index) + '"><summary><span class="session-tool-id">' + escape(first.id) + '–' + escape(last.id) + '</span>'
        + '<span class="session-tool-copy"><strong>' + escape(first.actionLabel) + ' ×' + run.calls.length + '</strong><code>' + escape(first.toolName) + '</code></span>'
        + '<span class="session-tool-time"><code>' + escape(formatStamp(first.startedAt) ?? '—') + '</code><small>' + escape(total ? formatLatency(total) + ' total' : '—') + '</small></span>'
        + (first.detail ? '<code class="session-tool-detail">' + escape(first.detail) + '</code>' : '')
        + '</summary>' + run.calls.map(call => toolRowMarkup(session,call)).join('') + '</details>';
    });
    // A show-more reveal replaces the old nested scroll box, so one long page
    // never traps the wheel inside eighteen independent scroll containers.
    return '<div class="session-call-list">' + blocks.slice(0,14).join('')
      + (blocks.length > 14 ? '<div class="session-call-overflow" data-call-overflow hidden>' + blocks.slice(14).join('') + '</div><button type="button" class="session-call-more" data-reveal-calls>Show ' + (blocks.length - 14) + ' more grouped rows</button>' : '')
      + '</div>';
  }

  function commitEventMarkup(session, commit, relation) {
    return '<article class="session-event commit" data-session-event="commits" id="session-commit-' + escape(commit.shortHash) + '"><button type="button" class="commit-head" ' + selectionAttrs({ type:'commit', hash:commit.hash, contextSessionId:session.sessionId }) + '>'
      + '<header class="session-event-head"><strong>' + escape(commit.shortHash) + ' · ' + escape(commit.subject) + '</strong><span>' + commit.fileCount + ' files</span></header>'
      + '<div class="session-event-body"><p>+' + commit.linesAdded + ' / -' + commit.linesRemoved + ' · ' + escape(formatClock(commit.committedAt ?? commit.authoredAt)) + ' · committed ' + escape(relation) + ' · shared paths remain contextual.</p></div></button></article>';
  }

  function sessionViewMarkup(item) {
    const session = item.session;
    const commits = commitsFor(item);
    const callsById = callsBySession.get(session.sessionId) ?? new Map();
    const title = item.story?.title ?? session.prompts?.[0]?.text ?? session.locator;
    const toolCounts = new Map();
    session.toolActivity.calls.forEach(call => toolCounts.set(call.toolName,(toolCounts.get(call.toolName) ?? 0) + 1));
    const rankedTools = [...toolCounts.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const fallbackTurns = session.prompts.map((prompt,index) => {
      const turnIndex = prompt.turnIndex ?? index + 1;
      return { index:turnIndex, anchorId:'turn-' + turnIndex, prompt, steps:[], response:null, durationMs:null, toolCallCount:0, messageCount:0 };
    });
    const turns = session.dialogue?.turns?.length ? session.dialogue.turns : fallbackTurns;
    const placement = placeCommits(commits,turns,session);
    const turnEvents = turns.map(turn => {
      const anchor = turn.anchorId ?? ('turn-' + turn.index);
      const prompt = '<button type="button" class="session-event prompt" data-session-event="prompts" ' + selectionAttrs({ type:'turn', sessionId:session.sessionId, turnIndex:turn.index }) + '><header class="session-event-head"><strong>User prompt ' + turn.index + '</strong><span>' + escape(turn.prompt?.timestamp ? formatClock(turn.prompt.timestamp) : '') + '</span></header><div class="session-event-body session-prose"><p>' + escape(turn.prompt?.text ?? 'Prompt unavailable after privacy filtering') + '</p></div></button>';
      const notes = turn.steps.filter(step => step.kind === 'note').map((step,noteIndex) => '<article class="session-event intermediate" data-session-event="intermediate"><div class="session-note-label">Intermediate response ' + (noteIndex + 1) + '</div><p>' + escape(step.text) + '</p></article>').join('');
      const calls = turn.steps.filter(step => step.kind === 'tool').map(step => callsById.get(step.callId)).filter(Boolean);
      const toolEvent = calls.length ? '<details class="session-event tools" data-session-event="tools"><summary class="session-event-head"><strong>' + calls.length + ' tool call' + (calls.length === 1 ? '' : 's') + '</strong><span>' + turn.toolCallCount + ' observed in turn</span></summary>' + toolListMarkup(session,calls) + '</details>' : '';
      const response = '<article class="session-event response' + (turn.response ? '' : ' session-unavailable') + '" data-session-event="responses"><header class="session-event-head"><strong>Assistant response</strong><span>' + (turn.response ? 'retained' : 'unavailable') + '</span></header><div class="session-event-body session-prose"><p>' + escape(turn.response ?? 'Response body was unavailable or removed by privacy filtering.') + '</p></div></article>';
      const clock = Number.isFinite(turn.startMs) ? formatShortClock(turn.startMs) + (Number.isFinite(turn.endMs) ? '–' + formatShortClock(turn.endMs) : '') + ' UTC · ' : '';
      const summary = clock + turn.messageCount + ' intermediate events · ' + turn.toolCallCount + ' tool calls' + (Number.isFinite(turn.durationMs) ? ' · ' + formatDuration(turn.durationMs) : '');
      const turnCommits = (placement.inTurn.get(turn.index) ?? []).map(commit => commitEventMarkup(session,commit,'within this turn window')).join('');
      return '<section class="session-turn" id="session-' + escape(anchor) + '" data-turn-index="' + turn.index + '"><header class="session-turn-head"><button type="button" class="turn-select" ' + selectionAttrs({ type:'turn', sessionId:session.sessionId, turnIndex:turn.index }) + '>Turn ' + turn.index + '</button><span>' + escape(summary) + '</span></header>' + prompt + notes + toolEvent + response + turnCommits + '</section>';
    }).join('');

    const placedCallIds = new Set(turns.flatMap(turn => turn.steps.filter(step => step.kind === 'tool').map(step => step.callId)));
    // Order the page-tail bucket by observed start time so a session with no
    // dialogue Turns still reads as a trace. This reuses the same startedAt the
    // timeline strip plots; it never infers a time the host did not observe.
    const unplacedCalls = session.toolActivity.calls
      .filter(call => !placedCallIds.has(call.id))
      .slice()
      .sort((left,right) => {
        const leftTime = Number.isFinite(left.startedAt) ? left.startedAt : Infinity;
        const rightTime = Number.isFinite(right.startedAt) ? right.startedAt : Infinity;
        return leftTime - rightTime || String(left.id).localeCompare(String(right.id));
      });
    const unplacedFiles = unplacedCalls.length || turns.length === 0 ? session.toolActivity.files : [];
    const unplacedFileEvent = unplacedFiles.length
      ? '<article class="session-event files"><header class="session-event-head"><strong>' + unplacedFiles.length + ' attributed file path' + (unplacedFiles.length === 1 ? '' : 's') + '</strong><span>observed tool evidence</span></header><div class="session-file-list">' + unplacedFiles.map(file => '<button type="button" ' + selectionAttrs({ type:'file', path:file.path, contextSessionId:session.sessionId }) + '>' + escape(file.path) + '</button>').join('') + '</div></article>'
      : '';
    const unplacedToolEvent = unplacedCalls.length
      ? '<details class="session-event tools" data-session-event="tools" open><summary class="session-event-head"><strong>' + unplacedCalls.length + ' tool call' + (unplacedCalls.length === 1 ? '' : 's') + ' not tied to a Turn</strong><span>ordered by observed time</span></summary>' + toolListMarkup(session,unplacedCalls) + '</details>'
      : '';
    const unplacedMarkup = unplacedToolEvent || unplacedFileEvent
      ? '<section class="session-turn session-unplaced" id="session-unplaced"><header class="session-turn-head"><strong>Unplaced evidence</strong><span>observed evidence retained outside dialogue</span></header>' + unplacedToolEvent + unplacedFileEvent + '</section>'
      : '';
    const outsideMarkup = placement.outside.length
      ? '<section class="session-turn session-outside" id="session-outside-commits"><header class="session-turn-head"><strong>Commits outside the observed turn windows</strong><span>' + placement.outside.length + ' commit' + (placement.outside.length === 1 ? '' : 's') + '</span></header><div class="session-outside-note">These commits are in scope for this Story or date, but their timestamps fall outside every observed Turn window. They are held here on purpose: no Turn is claimed to have produced them.</div>' + placement.outside.map(entry => commitEventMarkup(session,entry.commit,entry.relation)).join('') + '</section>'
      : '';

    const filters = rankedTools.slice(0,8).map(([toolName,count]) => '<label class="session-filter subtype"><input type="checkbox" checked data-session-tool-filter="' + escape(toolName) + '"><span>' + escape(toolName) + '</span><em>' + count + '</em></label>').join('');
    const sourceLabel = session.source === 'entire-checkpoint' ? 'Entire checkpoint' : 'Native session';
    const coverage = turnCoverageOf(session);
    const responseCount = session.dialogue?.responseCount ?? turns.filter(turn => turn.response).length;
    const noteCount = session.dialogue?.noteCount ?? turns.reduce((sum,turn) => sum + turn.steps.filter(step => step.kind === 'note').length,0);
    const truncatedNote = session.dialogue?.truncated ? '<span class="session-warning">Turn projection truncated</span>' : '';
    const jumpOptions = turns.map(turn => '<option value="session-' + escape(turn.anchorId ?? ('turn-' + turn.index)) + '">Turn ' + turn.index + (Number.isFinite(turn.startMs) ? ' · ' + formatShortClock(turn.startMs) : '') + '</option>').join('')
      + (unplacedMarkup ? '<option value="session-unplaced">Unplaced evidence</option>' : '')
      + (outsideMarkup ? '<option value="session-outside-commits">Commits outside turn windows</option>' : '');
    const timeline = turnEvents + unplacedMarkup + outsideMarkup || '<div class="empty-state">No retained dialogue or observed evidence exists for this session.</div>';
    const tracePanel = '<section class="session-mode-panel" id="session-panel-trace" role="tabpanel" aria-labelledby="session-tab-trace" data-session-mode-panel="trace">'
      + (session.toolActivity.totalCalls ? '<details class="session-axis-panel" data-session-axis open><summary><span>Activity timeline <em>' + session.toolActivity.totalCalls + ' calls</em></span><small>click a bar to jump · drag to zoom</small></summary><div class="session-axis" data-activity-chart="' + escape(session.sessionId) + '"></div></details>' : '')
      + '<div class="session-layout"><main class="session-timeline">' + timeline + '</main><aside class="session-sidebar"><section><h3>Jump to</h3><select class="jump-select" data-session-jump>' + jumpOptions + '</select><div class="session-bulk"><button type="button" data-expand-tools="open">Expand all calls</button><button type="button" data-expand-tools="close">Collapse all</button></div></section><section><h3>Filters</h3><div class="session-filter-list"><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="prompts"><span>Prompts</span><em>' + turns.length + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="responses"><span>Responses</span><em>' + responseCount + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="intermediate"><span>Intermediate</span><em>' + noteCount + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="commits"><span>Commits</span><em>' + commits.length + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="tools"><span>Tool calls</span><em>' + session.toolActivity.totalCalls + '</em></label>' + filters + '<label class="session-filter subtype"><input type="checkbox" checked data-session-file-filter><span>File paths</span><em>' + session.toolActivity.files.length + '</em></label></div></section><section><h3>Source</h3><div class="session-meta"><span>' + sourceLabel + '</span></div></section></aside></div></section>';
    const replayPanel = '<section class="session-mode-panel replay-shell" id="session-panel-replay" role="tabpanel" aria-labelledby="session-tab-replay" data-session-mode-panel="replay" hidden>'
      + '<div class="replay-boundary"><strong>Read-only evidence playback</strong><span>Replay advances through retained evidence. It never reruns tools, resumes the host session, or invents missing time.</span></div>'
      + '<div class="replay-layout"><main class="replay-stage" tabindex="0" aria-label="Current replay event; J and L move between events, Space toggles playback" data-replay-stage aria-live="polite"></main><aside class="replay-index"><div class="replay-index-tabs" role="tablist" aria-label="Replay index"><button type="button" id="replay-index-tab-events" role="tab" aria-controls="replay-index-body" aria-selected="true" tabindex="0" data-replay-index-tab="events">Events <span>' + session.replay.eventCount + '</span></button><button type="button" id="replay-index-tab-files" role="tab" aria-controls="replay-index-body" aria-selected="false" tabindex="-1" data-replay-index-tab="files">Files <span>' + session.replay.files.length + '</span></button></div><div class="replay-index-body" id="replay-index-body" role="tabpanel" aria-labelledby="replay-index-tab-events" data-replay-index-body></div></aside></div>'
      + '<section class="replay-transport" aria-label="Replay controls"><div class="replay-rail-head"><strong>Session timeline</strong><span data-replay-range></span></div><div class="replay-rail" data-replay-rail></div><div class="replay-rail-legend">' + replayLegendMarkup(session.replay) + '</div><div class="replay-controls"><button type="button" data-replay-step="-1">Previous event <kbd>J</kbd></button><button type="button" class="replay-play" data-replay-play>Play <kbd>Space</kbd></button><button type="button" data-replay-step="1">Next event <kbd>L</kbd></button><span class="replay-position" data-replay-position></span><div class="replay-speeds" aria-label="Replay speed">' + [1,2,4,8].map(speed => '<button type="button" data-replay-speed="' + speed + '" aria-pressed="' + String(speed === state.replaySpeed) + '">' + speed + 'x</button>').join('') + '</div></div></section></section>';
    const modeTabs = '<div class="session-mode-tabs" role="tablist" aria-label="Session view mode"><button type="button" id="session-tab-trace" role="tab" aria-controls="session-panel-trace" aria-selected="true" tabindex="0" data-session-mode="trace">Trace</button><button type="button" id="session-tab-replay" role="tab" aria-controls="session-panel-replay" aria-selected="false" tabindex="-1" data-session-mode="replay">Replay</button></div>';
    return { title, html:'<div class="session-shell"><header class="session-titlebar"><div><h2>' + escape(title) + '</h2><div class="session-meta"><span class="session-platform">' + escape(session.platform) + '</span><span>' + escape(session.models.join(', ') || 'model unavailable') + '</span><span>' + formatDuration(session.durationMs) + '</span><span title="' + escape(coverageTitle(session)) + '">' + coverage.turnCount + ' turns</span><span>' + session.toolActivity.totalCalls + ' tool calls</span><span>' + session.fileEditCount + ' file edits</span><span>' + escape(formatTokens(session.tokenUsage)) + '</span>' + truncatedNote + '</div></div><button class="session-context-button" data-session-context>Continuation packet</button></header>' + modeTabs + tracePanel + replayPanel + '</div>' };
  }

  function replayModel() {
    return state.sessionItem?.session?.replay ?? null;
  }

  function replayCurrentEvent() {
    const replay = replayModel();
    return replay?.events.find(event => event.id === state.replayEventId) ?? replay?.events[0] ?? null;
  }

  function replayTiming(event) {
    if (!event) return 'No event selected';
    if (event.timeBasis === 'observed') return formatStamp(event.atMs) + ' UTC · observed time';
    if (event.timeBasis === 'turn-boundary') return formatStamp(event.atMs) + ' UTC · Turn boundary, not exact event time';
    return 'Sequence only · timestamp unavailable';
  }

  /* The rail paints one colour per event type, so name only the types this
     session actually retained. */
  function replayLegendMarkup(replay) {
    const present = new Set(replay.events.map(event => event.type));
    const entries = [['prompt','Prompt'],['intermediate','Intermediate'],['response','Response'],['tool-call','Tool call'],['commit','Commit']]
      .filter(([type]) => present.has(type));
    if (replay.events.some(event => event.status === 'failed')) entries.push(['failed','Failed']);
    return entries.map(([type,label]) => '<span class="' + type + '">' + label + '</span>').join('');
  }

  function replayStageMarkup(event) {
    if (!event) return '<div class="empty-state">No retained replay event exists for this session.</div>';
    const files = event.files?.length
      ? '<div class="replay-stage-files"><strong>Files</strong>' + event.files.map(file => '<button type="button" data-replay-file="' + escape(file) + '"><code>' + escape(file) + '</code></button>').join('') + '</div>'
      : '';
    const unavailable = event.availability === 'unavailable' ? '<span class="replay-availability">Content unavailable</span>' : '';
    const excerpt = event.bodyExcerpt ? '<span class="replay-excerpt" title="The projection retained a bounded excerpt of this content.">Excerpt</span>' : '';
    const status = event.status === 'failed' ? '<span class="replay-status failed">Failed</span>' : '';
    const explain = event.selection ? '<button type="button" class="replay-explain" data-replay-explain>Explain evidence</button>' : '';
    return '<article class="replay-event-card ' + escape(event.type) + '"><header><div><small>' + escape(event.label) + '</small><h3>' + escape(event.title) + '</h3></div><div class="replay-event-badges">' + status + unavailable + excerpt + '</div></header>'
      + '<div class="replay-event-meta"><span>' + escape(replayTiming(event)) + '</span>' + (event.meta ? '<code>' + escape(event.meta) + '</code>' : '') + (Number.isFinite(event.durationMs) ? '<span>' + escape(formatLatency(event.durationMs)) + '</span>' : '') + '</div>'
      + '<div class="replay-event-body"><p>' + escape(event.body) + '</p></div>' + files
      + '<footer><span>' + (event.turnIndex ? 'Turn ' + event.turnIndex : 'Outside any observed Turn') + '</span>' + explain + '</footer></article>';
  }

  function renderReplayIndex() {
    const replay = replayModel();
    const body = document.querySelector('[data-replay-index-body]');
    if (!replay || !body) return;
    document.querySelectorAll('[data-replay-index-tab]').forEach(tab => {
      const selected = tab.dataset.replayIndexTab === state.replayIndexTab;
      tab.setAttribute('aria-selected',String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    body.setAttribute('aria-labelledby','replay-index-tab-' + state.replayIndexTab);
    if (state.replayIndexTab === 'files') {
      body.innerHTML = replay.files.length
        ? '<div class="replay-file-list">' + replay.files.map(file => '<button type="button" data-replay-file="' + escape(file.path) + '"><code>' + escape(file.path) + '</code><span>' + file.eventIds.length + ' events</span></button>').join('') + '</div>'
        : '<div class="empty-state">No repository-relative file was retained for Replay.</div>';
      return;
    }
    body.innerHTML = '<div class="replay-event-list">' + replay.events.map(event => { const current = event.id === state.replayEventId; return '<button type="button"' + (current ? ' class="replay-current"' : '') + ' data-replay-event="' + escape(event.id) + '" aria-current="' + (current ? 'step' : 'false') + '"><span class="replay-event-order">' + event.order + '</span><span class="replay-event-copy"><strong>' + escape(event.title) + '</strong><small>' + escape(replayTiming(event)) + '</small></span><span class="replay-event-kind">' + escape(event.type.replace('-', ' ')) + '</span></button>'; }).join('') + '</div>';
    keepReplayIndexRowVisible();
  }

  function renderReplayRail() {
    const replay = replayModel();
    const rail = document.querySelector('[data-replay-rail]');
    const range = document.querySelector('[data-replay-range]');
    if (!replay || !rail || !range) return;
    const timed = replay.events.filter(event => Number.isFinite(event.atMs));
    const start = replay.startMs;
    const end = replay.endMs;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || timed.length === 0) {
      range.textContent = 'Sequence axis · no observed event timing';
      rail.innerHTML = '<div class="replay-sequence-rail"><span>1</span><div></div><span>' + replay.eventCount + '</span></div>';
      return;
    }
    range.textContent = formatShortClock(start) + ' → ' + formatShortClock(end) + ' UTC · ' + formatSpan(end - start);
    const span = Math.max(1,end - start);
    const bins = new Map();
    const binCount = 120;
    for (const event of timed) {
      const index = Math.min(binCount - 1,Math.max(0,Math.floor(((event.atMs - start) / span) * binCount)));
      const bin = bins.get(index) ?? { index, events:[], failed:false };
      bin.events.push(event);
      if (event.status === 'failed') bin.failed = true;
      bins.set(index,bin);
    }
    const marks = [...bins.values()].map(bin => {
      const first = bin.events[0];
      const label = bin.events.length + ' event' + (bin.events.length === 1 ? '' : 's') + ' near ' + formatStamp(first.atMs) + ' UTC';
      return '<button type="button" class="replay-rail-mark ' + escape(first.type) + (bin.failed ? ' failed' : '') + '" data-replay-event="' + escape(first.id) + '" style="left:' + ((bin.index / binCount) * 100) + '%;width:' + Math.max(0.7,100 / binCount) + '%" aria-label="' + escape(label) + '" title="' + escape(label) + '"></button>';
    }).join('');
    rail.innerHTML = '<div class="replay-rail-track"><span class="replay-rail-fill"></span>' + marks + '<span class="replay-rail-cursor" data-replay-cursor></span></div><div class="replay-rail-labels"><span>' + escape(formatShortClock(start)) + '</span><span>' + escape(formatShortClock(end)) + '</span></div>';
    rail.dataset.startMs = String(start);
    rail.dataset.endMs = String(end);
  }

  /* Only the index's own scroller moves, so following the current event can never
     scroll Session View or the page underneath it. */
  function keepReplayIndexRowVisible() {
    const body = document.querySelector('[data-replay-index-body]');
    const row = body?.querySelector('.replay-event-list .replay-current');
    if (!body || !row) return;
    const view = body.getBoundingClientRect();
    const target = row.getBoundingClientRect();
    if (target.top >= view.top && target.bottom <= view.bottom) return;
    body.scrollTop += target.top - view.top - Math.max(0,(view.height - target.height) / 2);
  }

  function updateReplayPresentation() {
    const replay = replayModel();
    const event = replayCurrentEvent();
    if (!replay) return;
    const stage = document.querySelector('[data-replay-stage]');
    if (stage) stage.innerHTML = replayStageMarkup(event);
    document.querySelectorAll('[data-replay-event]').forEach(row => {
      const current = row.dataset.replayEvent === event?.id;
      row.classList.toggle('replay-current',current);
      if (row.closest('.replay-event-list')) row.setAttribute('aria-current',current ? 'step' : 'false');
    });
    keepReplayIndexRowVisible();
    const cursor = document.querySelector('[data-replay-cursor]');
    if (cursor) {
      const start = Number(cursor.closest('[data-replay-rail]')?.dataset.startMs);
      const end = Number(cursor.closest('[data-replay-rail]')?.dataset.endMs);
      if (Number.isFinite(event?.atMs) && end > start) {
        cursor.style.left = Math.min(100,Math.max(0,((event.atMs - start) / (end - start)) * 100)) + '%';
        cursor.hidden = false;
      } else cursor.hidden = true;
    }
    const position = document.querySelector('[data-replay-position]');
    if (position) position.textContent = 'Event ' + (event ? event.order : 0) + ' / ' + replay.eventCount;
    const play = document.querySelector('[data-replay-play]');
    if (play) {
      play.innerHTML = (state.replayPlaying ? 'Pause' : 'Play') + ' <kbd>Space</kbd>';
      play.setAttribute('aria-pressed',String(state.replayPlaying));
    }
    document.querySelectorAll('[data-replay-speed]').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.replaySpeed) === state.replaySpeed)));
  }

  function renderReplay() {
    const replay = replayModel();
    if (!replay) return;
    if (!replay.events.some(event => event.id === state.replayEventId)) {
      const selectedKey = selectionKey(state.selection);
      state.replayEventId = replay.events.find(event => selectionKey(event.selection) === selectedKey)?.id ?? replay.events[0]?.id ?? null;
    }
    renderReplayIndex();
    renderReplayRail();
    updateReplayPresentation();
  }

  function stopReplay() {
    if (state.replayTimer) clearTimeout(state.replayTimer);
    state.replayTimer = null;
    state.replayPlaying = false;
    updateReplayPresentation();
  }

  function scheduleReplay() {
    if (!state.replayPlaying) return;
    if (state.replayTimer) clearTimeout(state.replayTimer);
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    const delay = Math.max(reducedMotion ? 220 : 90,900 / state.replaySpeed);
    state.replayTimer = setTimeout(() => {
      state.replayTimer = null;
      const replay = replayModel();
      const current = replay?.events.findIndex(event => event.id === state.replayEventId) ?? -1;
      if (!replay || current >= replay.events.length - 1) {
        stopReplay();
        return;
      }
      setReplayEvent(replay.events[current + 1].id,{ updateHistory:true });
      scheduleReplay();
    },delay);
  }

  function setReplayPlaying(playing) {
    const replay = replayModel();
    if (!replay?.events.length) return;
    if (!playing) {
      stopReplay();
      return;
    }
    if (replay.events.at(-1)?.id === state.replayEventId) state.replayEventId = replay.events[0].id;
    state.replayPlaying = true;
    updateReplayPresentation();
    updateUrl();
    scheduleReplay();
  }

  function setReplayEvent(eventId,{ syncSelection = true, updateHistory = true } = {}) {
    const replay = replayModel();
    const event = replay?.events.find(candidate => candidate.id === eventId);
    if (!event) return;
    state.replayEventId = event.id;
    if (syncSelection && event.selection) setSelection(event.selection,{ updateHistory:false, reveal:false });
    updateReplayPresentation();
    if (updateHistory) updateUrl();
  }

  function stepReplay(delta) {
    const replay = replayModel();
    if (!replay?.events.length) return;
    const current = Math.max(0,replay.events.findIndex(event => event.id === state.replayEventId));
    const next = Math.max(0,Math.min(replay.events.length - 1,current + delta));
    setReplayEvent(replay.events[next].id);
    if (state.replayPlaying && next === replay.events.length - 1) stopReplay();
  }

  function setSessionMode(mode,{ updateHistory = true } = {}) {
    const next = mode === 'replay' ? 'replay' : 'trace';
    state.sessionMode = next;
    if (next !== 'replay') stopReplay();
    else {
      state.evidenceDrawerSuppressed = true;
      renderEvidenceDrawer();
    }
    document.querySelectorAll('[data-session-mode]').forEach(tab => {
      const selected = tab.dataset.sessionMode === next;
      tab.setAttribute('aria-selected',String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-session-mode-panel]').forEach(panel => { panel.hidden = panel.dataset.sessionModePanel !== next; });
    if (next === 'replay') renderReplay();
    if (updateHistory) updateUrl();
  }

  function applySessionFilters() {
    document.querySelectorAll('[data-session-kind-filter]').forEach(input => {
      document.querySelectorAll('[data-session-event="' + CSS.escape(input.dataset.sessionKindFilter) + '"]').forEach(event => event.classList.toggle('session-hidden',!input.checked));
    });
    document.querySelectorAll('[data-session-tool-filter]').forEach(input => {
      const selector = '[data-tool="' + CSS.escape(input.dataset.sessionToolFilter) + '"]';
      // A collapsed run stands in for its own tool, so hide the run summary with
      // the rows it represents; otherwise unchecking a tool leaves the run band
      // visible and the filter contradicts what is on screen.
      document.querySelectorAll('.session-tool-row' + selector + ', details.session-tool-run' + selector).forEach(row => row.classList.toggle('session-hidden',!input.checked));
    });
    const fileFilter = document.querySelector('[data-session-file-filter]');
    document.querySelectorAll('.session-tool-file').forEach(file => file.classList.toggle('session-hidden',fileFilter && !fileFilter.checked));
    // Report how many calls survive the current filters, counting a collapsed
    // run once per grouped call, so the sidebar total tracks what is shown.
    const toolsEm = document.querySelector('[data-session-kind-filter="tools"]')?.closest('.session-filter')?.querySelector('em');
    if (toolsEm) {
      let visible = 0;
      // Standalone rows count once; a run's inner rows are represented by the
      // run's own callCount, so they are excluded here to avoid double counting.
      // Disclosure state (closed details, "show more" overflow) is deliberately
      // ignored — the total tracks the filters, not what is expanded.
      document.querySelectorAll('#session-view .session-tool-row').forEach(row => {
        if (row.closest('.session-tool-run')) return;
        if (!row.closest('.session-hidden')) visible += 1;
      });
      document.querySelectorAll('#session-view details.session-tool-run').forEach(run => { if (!run.closest('.session-hidden')) visible += Number(run.dataset.callCount) || 0; });
      toolsEm.textContent = String(visible);
    }
  }

  function sessionSelectionTarget(selection,item) {
    if (!selection || sessionForSelection(selection)?.sessionId !== item.session.sessionId) return null;
    if (selection.type === 'turn') return document.getElementById('session-turn-' + selection.turnIndex);
    if (selection.type === 'tool-call') return document.getElementById('session-call-' + selection.callId);
    if (selection.type === 'commit') return document.getElementById('session-commit-' + (byCommit.get(selection.hash)?.shortHash ?? selection.hash.slice(0,7)));
    if (selection.type === 'file') {
      return document.querySelector('#session-view [data-selection-type="file"][data-file-path="' + CSS.escape(selection.path) + '"]')
        ?? document.getElementById('session-unplaced');
    }
    return null;
  }

  let jumpObserver = null;

  // Scroll-spy keeps "Jump to" reporting where the reader actually is; a static
  // select stuck on Turn 1 is not navigation for a fifty-turn session.
  function observeTurnsForJump() {
    jumpObserver?.disconnect();
    jumpObserver = null;
    const select = document.querySelector('[data-session-jump]');
    const view = document.getElementById('session-view');
    if (!select || !view || typeof IntersectionObserver !== 'function') return;
    const order = [...view.querySelectorAll('.session-turn')].map(section => section.id);
    const visible = new Set();
    jumpObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      const top = order.find(id => visible.has(id));
      if (top && select.value !== top) select.value = top;
    },{ root:view, rootMargin:'-8% 0px -72% 0px', threshold:0 });
    view.querySelectorAll('.session-turn').forEach(section => jumpObserver.observe(section));
  }

  function revealSelectionTarget(target) {
    if (!target) return;
    target.closest('.session-call-overflow')?.removeAttribute('hidden');
    let run = target.closest('details.session-tool-run');
    while (run) {
      run.open = true;
      run = run.parentElement?.closest('details.session-tool-run');
    }
    const tools = target.closest('details.session-event.tools');
    if (tools) tools.open = true;
    target.scrollIntoView({ block:'center' });
  }

  function openSessionView(item,selection = state.selection,trigger = document.activeElement,{ updateHistory = true } = {}) {
    const view = sessionViewMarkup(item);
    const params = new URLSearchParams(location.search);
    const restoringThisSession = params.get('session') === item.session.sessionId;
    const changingSession = state.sessionItem?.session?.sessionId !== item.session.sessionId;
    if (changingSession) {
      state.replayEventId = restoringThisSession ? params.get('replay-event') : null;
      state.sessionMode = restoringThisSession && params.get('session-mode') === 'replay' ? 'replay' : 'trace';
      state.replayIndexTab = 'events';
    }
    state.sessionItem = item;
    state.sessionTrigger = trigger;
    state.sessionOpen = true;
    document.getElementById('session-view-title').textContent = view.title;
    document.getElementById('session-view-body').innerHTML = view.html;
    document.getElementById('session-view').hidden = false;
    document.body.classList.add('session-open');
    document.getElementById('session-view-close').focus();
    setSessionMode(state.sessionMode,{ updateHistory:false });
    if (updateHistory) {
      state.sessionPushed = true;
      updateUrl({ push:true });
    }
    renderEvidenceDrawer();
    requestAnimationFrame(() => {
      const axis = document.querySelector('[data-session-mode-panel="trace"] [data-session-axis] [data-activity-chart]');
      if (axis && !axis.childElementCount) {
        renderActivityChart(axis);
        chartObserver?.observe(axis);
      }
      revealSelectionTarget(sessionSelectionTarget(selection,item));
      observeTurnsForJump();
      applySelectionPresentation();
    });
  }

  function teardownSessionView() {
    stopReplay();
    jumpObserver?.disconnect();
    jumpObserver = null;
    state.sessionOpen = false;
    state.sessionItem = null;
    state.sessionMode = 'trace';
    state.replayEventId = null;
    state.replayIndexTab = 'events';
    state.evidenceDrawerSuppressed = false;
    document.getElementById('session-view').hidden = true;
    document.getElementById('session-view-body').innerHTML = '';
    document.body.classList.remove('session-open');
    const trigger = state.sessionTrigger;
    state.sessionTrigger = null;
    renderEvidenceDrawer();
    if (trigger?.isConnected) trigger.focus();
  }

  function closeSessionView() {
    // The Session View owns a history entry, so Back and Close agree.
    if (state.sessionPushed) {
      state.sessionPushed = false;
      history.back();
      return;
    }
    teardownSessionView();
    updateUrl();
  }

  function itemForSession(session) {
    if (!session) return null;
    return state.items?.find(candidate => candidate.session?.sessionId === session.sessionId)
      ?? { story:null, session, link:{ evidenceKind:'contextual', confidence:'drawer' }, date:null };
  }

  // ---------------------------------------------------------------- evidence

  function sessionForSelection(selection) {
    const sessionId = selection?.sessionId ?? selection?.contextSessionId;
    if (sessionId && bySession.has(sessionId)) return bySession.get(sessionId);
    if (selection?.type === 'file') return report.sessions.find(session => session.toolActivity.files.some(file => file.path === selection.path)) ?? null;
    if (selection?.type === 'commit') return report.sessions.find(session => session.commitLinks.some(link => link.hash === selection.hash)) ?? null;
    return null;
  }

  function callTurnIndex(session, callId) {
    const turn = session?.dialogue?.turns?.find(item => item.steps.some(step => step.kind === 'tool' && step.callId === callId));
    return turn?.index ?? null;
  }

  function descriptorLabel(selection) {
    if (!selection) return 'Unknown evidence';
    if (selection.type === 'story') return byStory.get(selection.id)?.title ?? selection.id;
    const session = sessionForSelection(selection);
    if (selection.type === 'session') return session?.locator ?? selection.sessionId;
    if (selection.type === 'turn') return 'Turn ' + selection.turnIndex;
    if (selection.type === 'tool-call') {
      const call = session?.toolActivity.calls.find(item => item.id === selection.callId);
      return call ? call.id + ' · ' + call.actionLabel : selection.callId;
    }
    if (selection.type === 'file') return selection.path;
    if (selection.type === 'commit') return byCommit.get(selection.hash)?.shortHash ?? selection.hash.slice(0,7);
    return selectionKey(selection);
  }

  function relatedSelections(selection) {
    const related = new Map();
    const add = descriptor => {
      const key = selectionKey(descriptor);
      if (key && key !== selectionKey(selection)) related.set(key,descriptor);
    };
    const addSessionGraph = session => {
      if (!session) return;
      add({ type:'session', sessionId:session.sessionId });
      session.storyLinks.forEach(link => add({ type:'story', id:link.storyId }));
      session.dialogue?.turns?.forEach(turn => add({ type:'turn', sessionId:session.sessionId, turnIndex:turn.index }));
      session.toolActivity.calls.forEach(call => add({ type:'tool-call', sessionId:session.sessionId, callId:call.id }));
      session.toolActivity.files.forEach(file => add({ type:'file', path:file.path, contextSessionId:session.sessionId }));
      const directCommitLinks = session.commitLinks.filter(isDirectCommitLink);
      (directCommitLinks.length ? directCommitLinks : session.commitLinks).forEach(link => add({ type:'commit', hash:link.hash, contextSessionId:session.sessionId }));
    };
    const session = sessionForSelection(selection);
    if (selection.type === 'story') {
      const story = byStory.get(selection.id);
      story?.sessionLinks.forEach(link => addSessionGraph(bySession.get(link.sessionId)));
      story?.commitHashes.forEach(hash => add({ type:'commit', hash }));
      return related;
    }
    if (selection.type === 'session') {
      addSessionGraph(session);
      return related;
    }
    if (selection.type === 'turn') {
      add({ type:'session', sessionId:selection.sessionId });
      const turn = session?.dialogue?.turns?.find(item => item.index === selection.turnIndex);
      const calls = turn?.steps.filter(step => step.kind === 'tool') ?? [];
      calls.forEach(call => {
        add({ type:'tool-call', sessionId:selection.sessionId, callId:call.callId });
        call.filePaths?.forEach(path => add({ type:'file', path, contextSessionId:selection.sessionId }));
      });
      session?.storyLinks.forEach(link => add({ type:'story', id:link.storyId }));
      const paths = new Set(calls.flatMap(call => call.filePaths ?? []));
      const callIds = new Set(calls.map(call => call.callId));
      session?.commitLinks.filter(link => isDirectCommitLink(link)
        ? (link.commitCallId && callIds.has(link.commitCallId)) || link.linkedEditCallIds?.some(callId => callIds.has(callId))
        : link.overlappingFiles.some(path => paths.has(path))).forEach(link => add({ type:'commit', hash:link.hash, contextSessionId:selection.sessionId }));
      return related;
    }
    if (selection.type === 'tool-call') {
      add({ type:'session', sessionId:selection.sessionId });
      const call = session?.toolActivity.calls.find(item => item.id === selection.callId);
      const turnIndex = callTurnIndex(session,selection.callId);
      if (turnIndex) add({ type:'turn', sessionId:selection.sessionId, turnIndex });
      const paths = new Set(call?.filePaths ?? []);
      paths.forEach(path => add({ type:'file', path, contextSessionId:selection.sessionId }));
      session?.commitLinks.filter(link => isDirectCommitLink(link)
        ? link.commitCallId === selection.callId || link.linkedEditCallIds?.includes(selection.callId)
        : link.overlappingFiles.some(path => paths.has(path))).forEach(link => add({ type:'commit', hash:link.hash, contextSessionId:selection.sessionId }));
      return related;
    }
    if (selection.type === 'file') {
      report.sessions.filter(item => item.toolActivity.files.some(file => file.path === selection.path)).forEach(item => {
        add({ type:'session', sessionId:item.sessionId });
        item.toolActivity.calls.filter(call => call.filePaths?.includes(selection.path)).forEach(call => add({ type:'tool-call', sessionId:item.sessionId, callId:call.id }));
        item.storyLinks.forEach(link => add({ type:'story', id:link.storyId }));
      });
      report.commits.filter(commit => commit.files.some(file => file.path === selection.path)).forEach(commit => add({ type:'commit', hash:commit.hash, contextSessionId:session?.sessionId }));
      return related;
    }
    if (selection.type === 'commit') {
      const commit = byCommit.get(selection.hash);
      commit?.files.forEach(file => add({ type:'file', path:file.path, contextSessionId:session?.sessionId }));
      const linkedSessions = report.sessions.map(item => ({
        item,
        link:item.commitLinks.find(link => link.hash === selection.hash),
      })).filter(entry => entry.link);
      const directlyLinkedSessions = linkedSessions.filter(entry => isDirectCommitLink(entry.link));
      (directlyLinkedSessions.length ? directlyLinkedSessions : linkedSessions).forEach(({ item, link }) => {
        add({ type:'session', sessionId:item.sessionId });
        const linkedCallIds = new Set([link.commitCallId,...(link.linkedEditCallIds ?? [])].filter(Boolean));
        item.toolActivity.calls.filter(call => isDirectCommitLink(link)
          ? linkedCallIds.has(call.id)
          : call.filePaths?.some(path => link.overlappingFiles.includes(path))).forEach(call => add({ type:'tool-call', sessionId:item.sessionId, callId:call.id }));
        item.storyLinks.forEach(storyLink => add({ type:'story', id:storyLink.storyId }));
      });
    }
    return related;
  }

  function describeSelection(selection) {
    const session = sessionForSelection(selection);
    const base = {
      title:descriptorLabel(selection),
      locator:selectionKey(selection),
      kind:'observed',
      strength:'observed',
      source:'HarnessInspectorReportV1',
      facts:[],
      limitations:['This view explains retained evidence only; it does not mutate mappings, Git, or native session state.'],
      path:[],
    };
    if (selection.type === 'story') {
      const story = byStory.get(selection.id);
      const link = story?.sessionLinks[0];
      const linkedSession = link ? bySession.get(link.sessionId) : null;
      return { ...base,
        kind:link?.evidenceKind ?? story?.evidence ?? 'unmapped',
        strength:link?.strength ?? 'contextual',
        source:link?.source ?? 'feature-tree',
        facts:link?.facts ?? ['The Feature Tree defines this reviewed delivery scope.'],
        limitations:link?.limitations ?? ['No retained Session relationship is available for this Story.'],
        path:[story?.title ?? selection.id,link ? link.evidenceKind + '-for' : 'unmapped',linkedSession?.locator ?? 'No linked Session'],
      };
    }
    if (selection.type === 'session') {
      const link = session?.storyLinks[0] ?? session?.commitLinks[0];
      const story = link?.storyId ? byStory.get(link.storyId) : null;
      const commit = link?.hash ? byCommit.get(link.hash) : null;
      const coverage = turnCoverageOf(session);
      return { ...base,
        title:session?.locator ?? selection.sessionId,
        kind:link?.evidenceKind ?? 'unmapped', strength:link?.strength ?? 'contextual', source:link?.source ?? session?.source ?? 'native-session',
        facts:link?.facts ?? [coverage.turnCount + ' dialogue Turns are retained.',session?.toolActivity.totalCalls + ' normalized Tool Calls are retained.',session?.toolActivity.files.length + ' repository paths are attributed.'],
        limitations:link?.limitations ?? ['No reviewed Story or correlated Commit relationship is retained for this Session.'],
        path:story ? [story.title,link.evidenceKind + '-for',session.locator] : commit ? [session.locator,link.evidenceKind,commit.shortHash] : [session?.locator ?? selection.sessionId,'unmapped','No delivery owner'],
      };
    }
    if (selection.type === 'turn') {
      const turn = session?.dialogue?.turns?.find(item => item.index === selection.turnIndex);
      const observedWindow = Number.isFinite(turn?.startMs)
        ? 'Observed window: ' + formatShortClock(turn.startMs) + (Number.isFinite(turn.endMs) ? '–' + formatShortClock(turn.endMs) : '') + ' UTC.'
        : null;
      return { ...base,
        title:'Turn ' + selection.turnIndex, source:'session-dialogue',
        facts:[(turn?.toolCallCount ?? 0) + ' Tool Calls are observed in this Turn.',(turn?.messageCount ?? 0) + ' intermediate events sit between its retained prompt and response.',observedWindow].filter(Boolean),
        limitations:['Turn membership places activity in dialogue order; it does not prove which later Commit contains the result.'],
        path:[session?.locator ?? selection.sessionId,'observed-in','Turn ' + selection.turnIndex],
      };
    }
    if (selection.type === 'tool-call') {
      const call = session?.toolActivity.calls.find(item => item.id === selection.callId);
      const linkedEditCommit = session?.commitLinks.find(link => link.linkedEditCallIds?.includes(selection.callId));
      const createdCommit = session?.commitLinks.find(link => link.commitCallId === selection.callId);
      const linkedCommit = linkedEditCommit ?? createdCommit;
      const commit = linkedCommit ? byCommit.get(linkedCommit.hash) : null;
      const turnIndex = callTurnIndex(session,selection.callId);
      const path = [session?.locator ?? selection.sessionId];
      if (turnIndex) path.push('observed-in','Turn ' + turnIndex);
      path.push('observed',call?.id + ' · ' + call?.actionLabel);
      if (call?.filePaths?.[0]) path.push(call.operation ?? 'touched',call.filePaths[0]);
      if (commit) path.push(linkedEditCommit ? 'linked-before' : 'contains-commit-time',commit.shortHash);
      const stamp = formatStamp(call?.startedAt);
      return { ...base,
        title:call ? call.id + ' · ' + call.actionLabel : selection.callId,
        source:'NormalizedToolActivityV1',
        facts:[call?.toolName ? 'Native tool: ' + call.toolName + '.' : null,
          stamp ? 'Observed start: ' + stamp + ' UTC.' : 'Start time evidence is unavailable.',
          call?.status ? 'Observed status: ' + call.status + '.' : null,
          call?.durationStatus === 'observed' ? 'Observed duration: ' + formatLatency(call.durationMs) + '.' : 'Duration evidence is unavailable.',
          linkedEditCommit ? 'This Edit/Write call precedes commit ' + commit.shortHash + ' and shares an exact changed path.' : null,
          createdCommit ? 'Commit ' + commit.shortHash + ' was created during this observed call.' : null,
          ...(call?.filePaths?.map(item => 'Attributed path: ' + item + '.') ?? [])].filter(Boolean),
        limitations:[linkedEditCommit
          ? 'Exact path overlap and event order link this call to the Commit; they do not prove the final committed contents came exclusively from this call.'
          : createdCommit
            ? 'The call contains the Commit time, but it does not prove when or by which event the committed files were edited.'
          : 'A Tool Call observation proves retained activity metadata, not that a later Commit contains or was authored by that activity.'],
        path,
      };
    }
    if (selection.type === 'file') {
      const calls = session?.toolActivity.calls.filter(call => call.filePaths?.includes(selection.path)) ?? [];
      const commit = report.commits.find(item => item.files.some(file => file.path === selection.path));
      const link = commit ? session?.commitLinks.find(item => item.hash === commit.hash && item.overlappingFiles.includes(selection.path)) : null;
      const path = [];
      if (calls[0]) path.push(calls[0].id + ' · ' + calls[0].actionLabel,calls[0].operation ?? 'touched');
      path.push(selection.path);
      if (commit) path.push('changed-in',commit.shortHash);
      return { ...base,
        kind:link?.evidenceKind ?? 'observed', strength:link?.strength ?? 'observed', source:link?.source ?? 'NormalizedToolActivityV1 + Git commit evidence',
        facts:link?.facts ?? [calls.length + ' retained Tool Call(s) attribute this exact repository path.',commit ? 'The same exact path occurs in commit ' + commit.shortHash + '.' : 'No retained Commit changes this exact path.'],
        limitations:link?.limitations ?? ['An attributed or shared path does not prove authorship or that the observed call produced the final file contents.'],
        path,
      };
    }
    if (selection.type === 'commit') {
      const commit = byCommit.get(selection.hash);
      const link = session?.commitLinks.find(item => item.hash === selection.hash);
      return { ...base,
        title:commit ? commit.shortHash + ' · ' + commit.subject : selection.hash.slice(0,7),
        kind:link?.evidenceKind ?? 'contextual', strength:link?.strength ?? 'contextual', source:link?.source ?? 'git commit evidence',
        facts:link?.facts ?? [commit?.fileCount + ' changed file(s) are retained for this Commit.'],
        limitations:link?.limitations ?? ['The Commit is visible in the selected date or Story context, but no retained Session correlation is available.'],
        path:session ? [session.locator,link?.evidenceKind ?? 'contextual',commit?.shortHash ?? selection.hash.slice(0,7)] : [commit?.shortHash ?? selection.hash.slice(0,7),'unmapped','No correlated Session'],
      };
    }
    return base;
  }

  const RELATED_PRIORITY = {
    story:{ session:0, commit:1, turn:2, file:3, 'tool-call':4 },
    session:{ story:0, commit:1, turn:2, file:3, 'tool-call':4 },
    turn:{ 'tool-call':0, file:1, commit:2, session:3, story:4 },
    'tool-call':{ turn:0, file:1, commit:2, session:3, story:4 },
    file:{ commit:0, session:1, 'tool-call':2, story:3, turn:4 },
    commit:{ file:0, session:1, story:2, 'tool-call':3, turn:4 },
  };

  // Related objects are grouped and capped per type. A flat top-ten list let a
  // commit-heavy Session bury every Turn and Tool Call it actually contains.
  function relatedGroups(selection) {
    const priority = RELATED_PRIORITY[selection.type] ?? {};
    const byType = new Map();
    for (const descriptor of relatedSelections(selection).values()) {
      const bucket = byType.get(descriptor.type) ?? [];
      bucket.push(descriptor);
      byType.set(descriptor.type,bucket);
    }
    return [...byType.entries()]
      .sort((left,right) => (priority[left[0]] ?? 9) - (priority[right[0]] ?? 9))
      .map(([type,items]) => ({
        type,
        total:items.length,
        items:items.sort((left,right) => descriptorLabel(left).localeCompare(descriptorLabel(right),undefined,{ numeric:true })).slice(0,5),
      }));
  }

  function urlForState() {
    const url = new URL(location.href);
    ['feature','date','story','session','context-session','turn','call','file','commit','view','session-mode','replay-event'].forEach(key => url.searchParams.delete(key));
    url.searchParams.set('mode',state.mode);
    if (state.mode === 'feature' && state.scope) url.searchParams.set('feature',state.scope);
    if (state.mode === 'date' && state.scope) url.searchParams.set('date',state.scope);
    const selection = state.selection;
    if (selection?.type === 'story') url.searchParams.set('story',selection.id);
    if (selection?.sessionId) url.searchParams.set('session',selection.sessionId);
    if (selection?.contextSessionId) url.searchParams.set('context-session',selection.contextSessionId);
    if (selection?.type === 'turn') url.searchParams.set('turn',selection.turnIndex);
    if (selection?.type === 'tool-call') url.searchParams.set('call',selection.callId);
    if (selection?.type === 'file') url.searchParams.set('file',selection.path);
    if (selection?.type === 'commit') url.searchParams.set('commit',selection.hash);
    // Session View is a navigable state, so a copied link reopens the surface
    // the reviewer was reading rather than the workbench behind it.
    if (state.sessionOpen) {
      url.searchParams.set('view','session');
      const sessionId = state.sessionItem?.session?.sessionId;
      if (sessionId) url.searchParams.set('session',sessionId);
      if (state.sessionMode === 'replay') {
        url.searchParams.set('session-mode','replay');
        if (state.replayEventId) url.searchParams.set('replay-event',state.replayEventId);
      }
    }
    return url;
  }

  function updateUrl({ push = false } = {}) {
    if (state.syncingHistory) return;
    const url = urlForState();
    if (push) history.pushState({ view:'session' },'',url);
    else history.replaceState(null,'',url);
  }

  function applySelectionPresentation() {
    const selectedKey = selectionKey(state.selection);
    const related = state.selection ? relatedSelections(state.selection) : new Map();
    document.body.classList.toggle('has-evidence-selection',Boolean(selectedKey));
    // Emphasis is additive. De-emphasising every unrelated object used to fade
    // the trace a reviewer was reading and forced a full-document repaint.
    document.querySelectorAll('[data-selectable]').forEach(element => {
      const key = selectionKey(descriptorFromElement(element));
      element.classList.toggle('selection-selected',key === selectedKey);
      element.classList.toggle('selection-related',Boolean(selectedKey) && related.has(key));
      if (element.matches('button,[role="button"]')) element.setAttribute('aria-pressed',String(key === selectedKey));
    });
  }

  function setPickerCollapsed(collapsed,{ automatic = false } = {}) {
    const app = document.querySelector('.app');
    const toggle = document.querySelector('[data-toggle-picker]');
    app.classList.toggle('picker-collapsed',collapsed);
    if (automatic) app.dataset.drawerCollapsedPicker = 'true';
    else delete app.dataset.drawerCollapsedPicker;
    toggle?.setAttribute('aria-expanded',String(!collapsed));
    toggle?.setAttribute('aria-label',collapsed ? 'Expand Delivery Tree' : 'Collapse Delivery Tree');
  }

  function renderEvidenceDrawer() {
    const drawer = document.getElementById('evidence-drawer');
    const app = document.querySelector('.app');
    if (!state.selection || state.evidenceDrawerSuppressed) {
      drawer.hidden = true;
      document.body.classList.remove('drawer-open');
      if (app.dataset.drawerCollapsedPicker === 'true') setPickerCollapsed(false);
      return;
    }
    const description = describeSelection(state.selection);
    const groups = relatedGroups(state.selection);
    const path = description.path.map((label,index) => '<div class="evidence-path-row' + (index % 2 ? ' edge' : '') + '"><span>' + escape(label) + '</span></div>').join('');
    const facts = description.facts.length ? '<ul>' + description.facts.map(fact => '<li>' + escape(fact) + '</li>').join('') + '</ul>' : '<div class="evidence-source">No additional retained facts.</div>';
    const limitations = description.limitations.map(item => escape(item)).join(' ');
    const relatedMarkup = groups.length
      ? groups.map(group => '<div class="evidence-related-group"><h4>' + escape(group.type) + '<em>' + group.total + '</em></h4>'
        + group.items.map(item => '<button type="button" class="evidence-related" ' + selectionAttrs(item) + '><span>' + escape(descriptorLabel(item)) + '</span></button>').join('')
        + (group.total > group.items.length ? '<div class="evidence-related-more">' + (group.total - group.items.length) + ' more not listed; open Session View to browse them.</div>' : '')
        + '</div>').join('')
      : '<div class="evidence-source">No related retained objects.</div>';
    document.getElementById('evidence-drawer-title').textContent = description.title;
    document.getElementById('evidence-drawer-body').innerHTML = '<div class="evidence-overview">' + evidence(description.kind) + '<code>' + escape(description.locator) + '</code></div><section class="evidence-section"><h3>Evidence path</h3><div class="evidence-path">' + path + '</div></section><section class="evidence-section"><h3>Why linked · ' + escape(description.strength) + '</h3>' + facts + '</section><section class="evidence-section"><h3>Related objects</h3><div class="evidence-related-list">' + relatedMarkup + '</div></section><section class="evidence-section"><h3>Limitations</h3><div class="evidence-limitations">' + limitations + '</div></section><section class="evidence-section"><h3>Source</h3><div class="evidence-source">' + escape(description.source) + '</div><div class="evidence-copy-status" data-evidence-copy-status aria-live="polite"></div></section>';
    const open = document.querySelector('[data-open-evidence-session]');
    const session = sessionForSelection(state.selection);
    open.hidden = !session || state.sessionOpen;
    open.dataset.sessionId = session?.sessionId ?? '';
    drawer.hidden = false;
    document.body.classList.add('drawer-open');
    if (!state.sessionOpen && innerWidth > 760 && innerWidth < 1200 && !app.classList.contains('picker-collapsed')) setPickerCollapsed(true,{ automatic:true });
  }

  function setSelection(selection,{ updateHistory = true, reveal = true } = {}) {
    state.selection = selection;
    state.evidenceDrawerSuppressed = !reveal;
    renderEvidenceDrawer();
    applySelectionPresentation();
    if (updateHistory) updateUrl();
  }

  function clearSelection({ updateHistory = true } = {}) {
    state.selection = null;
    state.evidenceDrawerSuppressed = false;
    renderEvidenceDrawer();
    applySelectionPresentation();
    if (updateHistory) updateUrl();
  }

  function renderScopeIndex(items) {
    const wrapper = document.querySelector('.scope-index');
    const select = document.getElementById('scope-index');
    if (!wrapper || !select) return;
    wrapper.hidden = items.length < 4;
    select.innerHTML = '<option value="">Jump to workbench…</option>' + items.map((item,index) => {
      const label = itemTitle(item);
      return '<option value="workbench-card-' + index + '">' + escape([...label].length > 46 ? [...label].slice(0,45).join('') + '…' : label) + '</option>';
    }).join('');
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
      if (metric) {
        metric.hidden = value === 0;
        const metricLabel = value === 1
          ? metric.dataset.metricSingular ?? metric.dataset.metricLabel ?? name
          : metric.dataset.metricLabel ?? name;
        metric.setAttribute('aria-label',value + ' ' + metricLabel);
      }
    });
    state.items = items;
    document.getElementById('workbench-list').innerHTML = items.map(workbench).join('') || '<div class="empty-state">No provenance workbench exists in this scope.</div>';
    renderScopeIndex(items);
    document.querySelectorAll('[data-feature-id]').forEach(button => button.classList.toggle('active', state.mode === 'feature' && button.dataset.featureId === state.scope));
    document.querySelectorAll('[data-date]').forEach(button => button.classList.toggle('active', state.mode === 'date' && button.dataset.date === state.scope));
    if (state.selection?.type === 'tool-call') {
      const details = document.querySelector('[data-activity-session="' + CSS.escape(state.selection.sessionId) + '"]');
      if (details) details.open = true;
    }
    applySelectionPresentation();
  }

  function setMode(mode,{ preserveSelection = false, updateHistory = true } = {}) {
    state.mode = mode;
    if (mode === 'feature' && !byNode.has(state.scope)) state.scope = initialFeature;
    if (mode === 'date' && !report.days.some(day => day.date === state.scope)) state.scope = latestDay;
    if (!preserveSelection) state.selection = null;
    state.collapsedCards.clear();
    document.querySelectorAll('[data-mode]').forEach(button => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active',active);
      button.setAttribute('aria-selected',String(active));
    });
    document.querySelectorAll('.picker-panel').forEach(panel => {
      const active = panel.dataset.panel === mode;
      panel.classList.toggle('active',active);
      panel.hidden = !active;
    });
    renderScope();
    renderEvidenceDrawer();
    if (updateHistory) updateUrl();
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
    // The capability tree opens fully expanded so every declared node is
    // visible without hunting; the picker is short and reviewers scan it whole.
    document.querySelectorAll('[data-tree-item][aria-expanded]').forEach(item => setTreeItemExpanded(item,true));
  }

  document.addEventListener('click', event => {
    const chartReset = event.target.closest('[data-chart-reset]');
    if (chartReset) { setZoom(chartReset.dataset.chartReset,0,1); return; }
    const commitEvent = event.target.closest('.chart-commit');
    if (commitEvent) { showChartDetail(commitEvent); setSelection(descriptorFromElement(commitEvent)); return; }
    const bin = event.target.closest('[data-chart-bin]');
    if (bin) {
      const sessionId = bin.dataset.sessionId;
      // Inside Session View the strip is a minimap: a bar always scrolls the
      // list to the calls under it, and a multi-call bar zooms in as well.
      const inSession = event.target.closest('#session-view');
      const locate = () => inSession && revealSelectionTarget(sessionSelectionTarget({ type:'tool-call', sessionId, callId:bin.dataset.callId },state.sessionItem));
      if (Number(bin.dataset.binCount) === 1) { setSelection({ type:'tool-call', sessionId, callId:bin.dataset.callId }); locate(); return; }
      const surface = bin.ownerSVGElement?.querySelector('[data-chart-surface]');
      const fullMin = Number(surface?.dataset.fullMin);
      const fullWidth = Math.max(1,Number(surface?.dataset.fullMax) - fullMin);
      const from = (Number(bin.dataset.binFrom) - fullMin) / fullWidth;
      const to = (Number(bin.dataset.binTo) - fullMin) / fullWidth;
      const padding = Math.max(0.004,(to - from) * 0.3);
      setZoom(sessionId,Math.max(0,from - padding),Math.min(1,to + padding));
      locate();
      return;
    }
    const mark = event.target.closest('.chart-mark, .chart-ribbon-block');
    if (mark) {
      showChartDetail(mark);
      const descriptor = descriptorFromElement(mark);
      setSelection(descriptor);
      if (event.target.closest('#session-view')) revealSelectionTarget(sessionSelectionTarget(descriptor,state.sessionItem));
      return;
    }
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
      // Selecting a capability node only navigates scope. It must not set the
      // evidence selection, so the detail header stays unhighlighted until the
      // reviewer clicks an actual object inside the workbench.
      state.scope = feature.dataset.featureId;
      setTreeItemExpanded(feature.closest('[data-tree-item]'),true);
      setMode('feature');
      return;
    }
    const pickerToggle = event.target.closest('[data-toggle-picker]');
    if (pickerToggle) {
      setPickerCollapsed(!document.querySelector('.app').classList.contains('picker-collapsed'));
      return;
    }
    const date = event.target.closest('[data-date]');
    if (date) { state.scope = date.dataset.date; setMode('date'); return; }
    const cardToggle = event.target.closest('[data-toggle-card]');
    if (cardToggle) {
      const index = Number(cardToggle.dataset.toggleCard);
      const collapsed = cardToggle.closest('.workbench').classList.toggle('card-collapsed');
      if (collapsed) state.collapsedCards.add(index);
      else state.collapsedCards.delete(index);
      cardToggle.setAttribute('aria-expanded',String(!collapsed));
      cardToggle.textContent = collapsed ? '+' : '−';
      return;
    }
    const openSession = event.target.closest('[data-open-session]');
    if (openSession) {
      const item = itemForSession(bySession.get(openSession.dataset.openSession));
      if (item) openSessionView(item,state.selection,openSession);
      return;
    }
    const openSessionFor = event.target.closest('[data-open-session-for]');
    if (openSessionFor) {
      const item = itemForSession(bySession.get(openSessionFor.dataset.openSessionFor));
      if (item) openSessionView(item,state.selection,openSessionFor);
      return;
    }
    const deliveryToggle = event.target.closest('[data-toggle-delivery]');
    if (deliveryToggle) {
      const workbench = deliveryToggle.closest('.workbench');
      setDeliveryCollapsed(workbench,!workbench.classList.contains('delivery-collapsed'));
      return;
    }
    const revealCalls = event.target.closest('[data-reveal-calls]');
    if (revealCalls) {
      revealCalls.parentElement.querySelector('[data-call-overflow]')?.removeAttribute('hidden');
      revealCalls.remove();
      return;
    }
    const bulk = event.target.closest('[data-expand-tools]');
    if (bulk) {
      const open = bulk.dataset.expandTools === 'open';
      document.querySelectorAll('#session-view details.session-event.tools').forEach(details => { details.open = open; });
      if (!open) document.querySelectorAll('#session-view details.session-tool-run').forEach(details => { details.open = false; });
      return;
    }
    const sessionMode = event.target.closest('[data-session-mode]');
    if (sessionMode) { setSessionMode(sessionMode.dataset.sessionMode); return; }
    const replayIndexTab = event.target.closest('[data-replay-index-tab]');
    if (replayIndexTab) {
      state.replayIndexTab = replayIndexTab.dataset.replayIndexTab === 'files' ? 'files' : 'events';
      renderReplayIndex();
      return;
    }
    const replayEvent = event.target.closest('[data-replay-event]');
    if (replayEvent) { setReplayEvent(replayEvent.dataset.replayEvent); return; }
    const replayFile = event.target.closest('[data-replay-file]');
    if (replayFile) {
      const filePath = replayFile.dataset.replayFile;
      const file = replayModel()?.files.find(candidate => candidate.path === filePath);
      if (file?.eventIds[0]) setReplayEvent(file.eventIds[0],{ syncSelection:false, updateHistory:false });
      setSelection({ type:'file', path:filePath, contextSessionId:state.sessionItem?.session?.sessionId ?? null },{ reveal:false });
      return;
    }
    const replayStep = event.target.closest('[data-replay-step]');
    if (replayStep) { stepReplay(Number(replayStep.dataset.replayStep)); return; }
    if (event.target.closest('[data-replay-play]')) { setReplayPlaying(!state.replayPlaying); return; }
    const replaySpeed = event.target.closest('[data-replay-speed]');
    if (replaySpeed) {
      state.replaySpeed = Number(replaySpeed.dataset.replaySpeed) || 1;
      updateReplayPresentation();
      if (state.replayPlaying) scheduleReplay();
      return;
    }
    if (event.target.closest('[data-replay-explain]')) {
      const current = replayCurrentEvent();
      if (current?.selection) setSelection(current.selection);
      return;
    }
    const selectable = event.target.closest('[data-selectable]');
    if (selectable) { setSelection(descriptorFromElement(selectable)); return; }
    if (event.target.closest('[data-close-session]')) { closeSessionView(); return; }
    if (event.target.closest('[data-close-evidence]')) { clearSelection(); return; }
    const openEvidenceSession = event.target.closest('[data-open-evidence-session]');
    if (openEvidenceSession) {
      const item = itemForSession(bySession.get(openEvidenceSession.dataset.sessionId));
      if (item) openSessionView(item,state.selection,openEvidenceSession);
      return;
    }
    if (event.target.closest('[data-copy-evidence-link]')) {
      const status = document.querySelector('[data-evidence-copy-status]');
      if (!navigator.clipboard?.writeText) {
        if (status) status.textContent = 'Copy unavailable; use the current address.';
        return;
      }
      navigator.clipboard.writeText(location.href).then(() => {
        if (status) status.textContent = 'Evidence link copied.';
      }).catch(() => {
        if (status) status.textContent = 'Copy unavailable; use the current address.';
      });
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
    const mark = event.target.closest?.('.chart-mark, .chart-ribbon-block, .chart-commit, [data-chart-bin]');
    if (mark) showChartDetail(mark);
  });

  document.addEventListener('focusin', event => {
    const mark = event.target.closest?.('.chart-mark, .chart-ribbon-block, .chart-commit, [data-chart-bin]');
    if (mark) showChartDetail(mark);
  });

  document.addEventListener('toggle', event => {
    const axisPanel = event.target.closest?.('[data-session-axis]');
    if (axisPanel) {
      if (!axisPanel.open) return;
      const axis = axisPanel.querySelector('[data-activity-chart]');
      if (axis && !axis.childElementCount) {
        renderActivityChart(axis);
        chartObserver?.observe(axis);
      }
      return;
    }
    const details = event.target.closest?.('[data-activity-session]');
    if (!details) return;
    const workbench = details.closest('.workbench');
    workbench?.classList.toggle('activity-expanded',details.open);
    if (!details.open) return;
    // Activity is the focus surface. Give its chart the delivery width on each
    // open transition, while leaving the delivery toggle available for a
    // reviewer who wants both surfaces visible afterward.
    setDeliveryCollapsed(workbench,true);
    const target = details.querySelector('[data-activity-chart]');
    if (!target || target.childElementCount) return;
    // Render synchronously: the open Details already has layout, and a hidden
    // tab starves requestAnimationFrame. Deferring left the chart permanently
    // empty, because an already-open Details never fires toggle again.
    renderActivityChart(target);
    chartObserver?.observe(target);
    requestAnimationFrame(() => target.querySelector('.selection-selected')?.scrollIntoView({ block:'nearest', inline:'center' }));
  }, true);

  document.addEventListener('change', event => {
    if (event.target.matches('[data-session-kind-filter], [data-session-tool-filter], [data-session-file-filter]')) applySessionFilters();
    if (event.target.matches('[data-session-jump]')) document.getElementById(event.target.value)?.scrollIntoView({ behavior:'smooth', block:'start' });
    if (event.target.matches('[data-scope-index]') && event.target.value) {
      document.getElementById(event.target.value)?.scrollIntoView({ behavior:'smooth', block:'start' });
      event.target.value = '';
    }
  });

  document.addEventListener('pointerdown', event => {
    const surface = event.target.closest('[data-chart-surface]');
    if (surface) {
      const svg = surface.ownerSVGElement;
      const rect = svg.getBoundingClientRect();
      const scale = (Number(svg.getAttribute('width')) || rect.width) / (rect.width || 1);
      state.brush = {
        surface,
        brush:svg.querySelector('[data-chart-brush]'),
        rect,
        scale,
        startX:(event.clientX - rect.left) * scale,
      };
      surface.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    const handle = event.target.closest('[data-resize-lane]');
    if (!handle) return;
    const grid = handle.closest('.workbench-grid');
    const prompt = grid.querySelector('.prompt-lane').getBoundingClientRect();
    const delivery = grid.querySelector('.delivery-lane').getBoundingClientRect();
    state.resize = { handle, grid, kind:handle.dataset.resizeLane, startX:event.clientX, promptWidth:prompt.width, deliveryWidth:delivery.width };
    handle.classList.add('resizing');
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  document.addEventListener('pointermove', event => {
    const brush = state.brush;
    if (brush) {
      const current = (event.clientX - brush.rect.left) * brush.scale;
      const left = Math.min(brush.startX,current);
      const width = Math.abs(current - brush.startX);
      brush.brush.setAttribute('x',String(left));
      brush.brush.setAttribute('width',String(width));
      if (width > 2) brush.brush.removeAttribute('hidden');
      return;
    }
    const resize = state.resize;
    if (!resize) return;
    const laneWidths = document.getElementById('workbench-list').style;
    const gridWidth = resize.grid.getBoundingClientRect().width;
    if (resize.kind === 'prompt') {
      const next = Math.max(180,Math.min(gridWidth - resize.deliveryWidth - 330,resize.promptWidth + event.clientX - resize.startX));
      laneWidths.setProperty('--prompt-width',next + 'px');
    } else {
      const next = Math.max(240,Math.min(gridWidth - resize.promptWidth - 330,resize.deliveryWidth - event.clientX + resize.startX));
      laneWidths.setProperty('--delivery-width',next + 'px');
    }
  });

  document.addEventListener('pointerup', event => {
    const brush = state.brush;
    if (brush) {
      const current = (event.clientX - brush.rect.left) * brush.scale;
      const left = Math.min(brush.startX,current);
      const right = Math.max(brush.startX,current);
      brush.brush.setAttribute('hidden','');
      brush.brush.setAttribute('width','0');
      state.brush = null;
      if (right - left > 6) {
        const fullMin = Number(brush.surface.dataset.fullMin);
        const fullWidth = Math.max(1,Number(brush.surface.dataset.fullMax) - fullMin);
        setZoom(brush.surface.dataset.sessionId,(chartPositionAt(brush.surface,left) - fullMin) / fullWidth,(chartPositionAt(brush.surface,right) - fullMin) / fullWidth);
      }
      return;
    }
    state.resize?.handle.classList.remove('resizing');
    state.resize = null;
  });

  document.addEventListener('keydown', event => {
    const sessionModeTab = event.target.closest?.('[data-session-mode]');
    if (sessionModeTab && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const nextMode = sessionModeTab.dataset.sessionMode === 'trace' ? 'replay' : 'trace';
      setSessionMode(nextMode);
      document.querySelector('[data-session-mode="' + nextMode + '"]')?.focus();
      event.preventDefault();
      return;
    }
    const replayIndexTab = event.target.closest?.('[data-replay-index-tab]');
    if (replayIndexTab && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      state.replayIndexTab = replayIndexTab.dataset.replayIndexTab === 'events' ? 'files' : 'events';
      renderReplayIndex();
      document.querySelector('[data-replay-index-tab="' + state.replayIndexTab + '"]')?.focus();
      event.preventDefault();
      return;
    }
    const shortcutTarget = event.target.closest?.('input, select, textarea, button, [contenteditable="true"]');
    if (state.sessionOpen && state.sessionMode === 'replay' && !shortcutTarget) {
      const key = event.key.toLowerCase();
      if (event.key === ' ') setReplayPlaying(!state.replayPlaying);
      else if (key === 'j' || event.key === 'ArrowLeft') stepReplay(-1);
      else if (key === 'l' || event.key === 'ArrowRight') stepReplay(1);
      else if ([1,2,4,8].includes(Number(event.key))) {
        state.replaySpeed = Number(event.key);
        updateReplayPresentation();
        if (state.replayPlaying) scheduleReplay();
      } else if (key === 'p') stepReplay(-1);
      else if (key === 'n') stepReplay(1);
      else if (event.key !== 'Escape') return;
      if (event.key !== 'Escape') {
        event.preventDefault();
        return;
      }
    }
    const bin = event.target.closest?.('[data-chart-bin]');
    if (bin && (event.key === 'Enter' || event.key === ' ')) {
      bin.dispatchEvent(new MouseEvent('click',{ bubbles:true }));
      event.preventDefault();
      return;
    }
    const selectable = event.target.closest?.('[data-selectable]');
    if (selectable && !selectable.matches('button') && (event.key === 'Enter' || event.key === ' ')) {
      setSelection(descriptorFromElement(selectable));
      event.preventDefault();
      return;
    }
    const modeTab = event.target.closest?.('[data-mode]');
    if (modeTab && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const nextMode = modeTab.dataset.mode === 'feature' ? 'date' : 'feature';
      const nextTab = document.querySelector('[data-mode="' + nextMode + '"]');
      setMode(nextMode);
      nextTab?.focus();
      event.preventDefault();
      return;
    }
    const resizeHandle = event.target.closest?.('[data-resize-lane]');
    if (resizeHandle && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const workbench = resizeHandle.closest('.workbench');
      const laneWidths = document.getElementById('workbench-list').style;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      if (resizeHandle.dataset.resizeLane === 'prompt') {
        const width = workbench.querySelector('.prompt-lane').getBoundingClientRect().width;
        laneWidths.setProperty('--prompt-width',Math.max(180,width + direction * 24) + 'px');
      } else {
        const width = workbench.querySelector('.delivery-lane').getBoundingClientRect().width;
        laneWidths.setProperty('--delivery-width',Math.max(240,width - direction * 24) + 'px');
      }
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      if (!document.getElementById('continuation-backdrop').hidden) document.getElementById('continuation-backdrop').hidden = true;
      else if (state.sessionOpen) closeSessionView();
      else if (state.selection) clearSelection();
    }
  });

  // Back and forward move between Inspector states instead of leaving the
  // report, so a Session View deep link behaves like a real navigation step.
  addEventListener('popstate', () => {
    state.syncingHistory = true;
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode') === 'date' ? 'date' : 'feature';
    const scope = mode === 'feature' ? params.get('feature') : params.get('date');
    if (mode === 'feature' ? byNode.has(scope) : report.days.some(day => day.date === scope)) state.scope = scope;
    state.selection = selectionFromUrl(params);
    setMode(mode,{ preserveSelection:true, updateHistory:false });
    const session = bySession.get(params.get('session'));
    if (params.get('view') === 'session' && session) {
      state.sessionMode = params.get('session-mode') === 'replay' ? 'replay' : 'trace';
      state.replayEventId = params.get('replay-event');
      const item = itemForSession(session);
      if (item) openSessionView(item,state.selection,state.sessionTrigger,{ updateHistory:false });
    } else if (state.sessionOpen) {
      state.sessionPushed = false;
      teardownSessionView();
    }
    renderEvidenceDrawer();
    applySelectionPresentation();
    state.syncingHistory = false;
  });

  state.selection = selectionFromUrl();
  initializeTree();
  setMode(state.mode,{ preserveSelection:true, updateHistory:false });
  if (state.selection) setSelection(state.selection,{ updateHistory:false });
  if (initialParams.get('view') === 'session') {
    const item = itemForSession(bySession.get(initialParams.get('session')));
    if (item) openSessionView(item,state.selection,null,{ updateHistory:false });
  }
  updateUrl();
})();

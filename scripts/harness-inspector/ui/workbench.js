(() => {
  const report = JSON.parse(document.getElementById("inspector-data").textContent);
  const byNode = new Map(report.featureTree.nodes.map(node => [node.id,node]));
  const byStory = new Map(report.stories.map(story => [story.id,story]));
  const bySession = new Map(report.sessions.map(session => [session.sessionId,session]));
  const byCommit = new Map(report.commits.map(commit => [commit.hash,commit]));
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
    sessionTrigger:null,
  };
  const escape = value => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
  const formatDuration = value => Number.isFinite(value) ? (value >= 3600000 ? (value / 3600000).toFixed(1) + "h" : Math.max(1,Math.round(value / 60000)) + "m") : "unknown";
  const formatClock = value => {
    const time = new Date(value ?? NaN);
    return Number.isNaN(time.getTime()) ? 'time unknown' : String(time.getUTCHours()).padStart(2,'0') + ':' + String(time.getUTCMinutes()).padStart(2,'0') + ' UTC';
  };
  const formatTokens = usage => {
    const total = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0);
    return total >= 1000 ? (Math.round(total / 100) / 10) + 'K tokens' : total + ' tokens';
  };
  const evidence = (kind, label = kind) => '<span class="evidence ' + escape(kind) + '">' + escape(label) + '</span>';

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
    if (declaredPrompt) cards.push('<button type="button" class="intent-card declared-intent" ' + selectionAttrs({ type:'story', id:item.story.id }) + '><p>' + escape(declaredPrompt) + '</p><small>Feature Tree intent · ' + escape(item.story.evidence) + '</small></button>');
    prompts.forEach((prompt,index) => cards.push('<button type="button" class="intent-card" ' + selectionAttrs({ type:'turn', sessionId:session.sessionId, turnIndex:index + 1 }) + '><p>' + escape(prompt.text) + '</p><small>User turn ' + (index + 1) + (prompt.timestamp ? ' · ' + escape(prompt.timestamp) : '') + '</small></button>'));
    const counts = !session ? 'no linked session'
      : session.retainedUserTurnCount === session.userTurnCount && session.userTurnCount === session.promptObservationCount
        ? session.userTurnCount + ' user turn' + (session.userTurnCount === 1 ? '' : 's')
        : session.retainedUserTurnCount + ' shown · ' + session.userTurnCount + ' normalized · ' + session.promptObservationCount + ' observations';
    return '<section class="lane prompt-lane' + (cards.length ? '' : ' lane-empty') + '"><div class="lane-title"><strong>User prompts</strong><span>' + escape(counts) + '</span></div>' + (cards.join("") || '<div class="empty-state">No retained privacy-safe user turn for this scope.</div>') + '</section>';
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
      const fileSelection = { type:'file', path:file.path, contextSessionId:link?.sessionId ?? null };
      return '<button type="button" class="file-row" ' + selectionAttrs(fileSelection) + '><code title="' + escape(file.path) + '">' + escape(file.display) + '</code><span class="delta">' + (Number.isFinite(file.added) ? '+' + file.added : 'bin') + ' / ' + (Number.isFinite(file.removed) ? '-' + file.removed : 'bin') + ' ' + evidence(shared ? sharedKind : 'commit-change', shared ? sharedLabel : 'commit') + '</span></button>';
    }).join('')).join('');
  }

  function deliveryLane(item, commits) {
    const cards = commits.map(commit => {
      const link = item.session?.commitLinks?.find(candidate => candidate.hash === commit.hash) ?? null;
      const kind = link?.evidenceKind ?? (item.story?.commitHashes?.includes(commit.hash) ? item.story.evidence : 'contextual');
      const label = kind === 'file-context' ? 'same-file history' : kind === 'observed-overlap' ? 'observed same-path' : kind;
      const relation = link ? (link.evidenceKind === 'file-context' ? ' · same-file context' : ' · ' + escape(link.confidence) + ' correlation') : '';
      const contextSessionId = item.session?.sessionId ?? null;
      const linked = link ? { ...link, sessionId:contextSessionId } : null;
      return '<article class="commit-card"><button type="button" class="commit-head" ' + selectionAttrs({ type:'commit', hash:commit.hash, contextSessionId }) + '><div class="commit-head-line"><code>' + escape(commit.shortHash) + '</code>' + evidence(kind,label) + '</div><p>' + escape(commit.subject) + '</p><div class="commit-stats">' + commit.fileCount + ' files · +' + commit.linesAdded + ' / -' + commit.linesRemoved + relation + '</div></button><div class="file-tree">' + (fileTree(commit,linked) || '<div class="empty-state">No changed paths retained.</div>') + '</div></article>';
    }).join('');
    if (!commits.length) return '<section class="lane delivery-lane lane-empty"><div class="lane-title"><div class="delivery-title-copy"><strong>Commits / files</strong><span>0 commits</span></div></div><div class="empty-state">No commit is linked to this session or Story.</div></section>';
    return '<section class="lane delivery-lane"><div class="lane-title"><div class="delivery-title-copy"><strong>Commits / files</strong><span>' + commits.length + ' commits</span></div><button class="delivery-toggle" data-toggle-delivery aria-expanded="true" aria-label="Collapse commits and files"><span class="open-label">Hide</span><span class="closed-label">Show files</span></button></div><div class="delivery-content">' + cards + '</div></section>';
  }

  function workbench(item,index) {
    const commits = commitsFor(item);
    const session = item.session;
    const title = item.story?.title
      ?? (item.date ? (session?.prompts?.[0]?.text ?? session?.locator ?? 'Commits without a linked session') : ('Activity on ' + (session?.day ?? 'unknown date')));
    const kicker = item.story?.featureTitle ?? (item.date ? (session ? 'Session · ' + formatClock(session.firstSeen) : 'Unlinked commits') : 'Unmapped');
    const sessionMeta = session ? session.locator + ' · ' + formatDuration(session.durationMs) : 'No linked session';
    const sessionAction = session ? '<button class="prepare-button" data-open-session="' + index + '">Open session</button>' : '';
    const headerSelection = session
      ? { type:'session', sessionId:session.sessionId }
      : item.story ? { type:'story', id:item.story.id } : null;
    const header = headerSelection
      ? '<button type="button" class="workbench-object-select" ' + selectionAttrs(headerSelection) + '><small>' + escape(kicker) + '</small><h3>' + escape(title) + '</h3><div class="meta">' + escape(sessionMeta) + '</div></button>'
      : '<div><small>' + escape(kicker) + '</small><h3>' + escape(title) + '</h3><div class="meta">' + escape(sessionMeta) + '</div></div>';
    return '<article class="workbench" data-workbench="' + index + '" data-session-context="' + escape(session?.sessionId ?? '') + '"><header class="workbench-head">' + header + '<div class="head-actions">' + evidence(item.link.evidenceKind) + sessionAction + '</div></header><div class="workbench-grid">' + promptLane(item) + '<div class="lane-resizer prompt" data-resize-lane="prompt" role="separator" aria-orientation="vertical" aria-label="Resize prompt and activity lanes" tabindex="0"></div>' + activityLane(item) + '<div class="lane-resizer delivery" data-resize-lane="delivery" role="separator" aria-orientation="vertical" aria-label="Resize activity and delivery lanes" tabindex="0"></div>' + deliveryLane(item,commits) + '</div></article>';
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
    const toolRow = step => '<button type="button" class="session-tool-row" data-session-tool-row data-tool="' + escape(step.toolName) + '" id="session-call-' + escape(step.callId) + '" ' + selectionAttrs({ type:'tool-call', sessionId:session.sessionId, callId:step.callId }) + '><span>' + escape(step.callId) + '</span><span class="session-tool-copy"><strong>' + escape(step.actionLabel) + '</strong><code title="' + escape(step.toolName) + '">' + escape(step.toolName) + '</code></span><small>' + (step.durationStatus === 'observed' ? escape(step.durationMs + 'ms') : '—') + '</small>' + (step.detail ? '<code class="session-tool-detail">' + escape(step.detail) + '</code>' : '') + (step.filePaths?.length ? '<code class="session-tool-file">' + escape(step.filePaths.join(' · ')) + '</code>' : '') + '</button>';
    const commitEvent = commit => '<article class="session-event commit" data-session-event="commits" id="session-commit-' + escape(commit.shortHash) + '"><button type="button" class="commit-head" ' + selectionAttrs({ type:'commit', hash:commit.hash, contextSessionId:session.sessionId }) + '><header class="session-event-head"><strong>' + escape(commit.shortHash) + ' · ' + escape(commit.subject) + '</strong><span>' + commit.fileCount + ' files</span></header><div class="session-event-body"><p>+' + commit.linesAdded + ' / -' + commit.linesRemoved + ' · commit evidence; shared paths remain contextual.</p></div></button></article>';
    const turnEvents = turns.map((turn,index) => {
      const prompt = '<button type="button" class="session-event prompt" data-session-event="prompts" ' + selectionAttrs({ type:'turn', sessionId:session.sessionId, turnIndex:turn.index }) + '><header class="session-event-head"><strong>User prompt ' + turn.index + '</strong><span>' + escape(turn.prompt?.timestamp ?? '') + '</span></header><div class="session-event-body session-prose"><p>' + escape(turn.prompt?.text ?? 'Prompt unavailable after privacy filtering') + '</p></div></button>';
      const notes = turn.steps.filter(step => step.kind === 'note').map((step,noteIndex) => '<article class="session-event intermediate" data-session-event="intermediate"><div class="session-note-label">Intermediate response ' + (noteIndex + 1) + '</div><p>' + escape(step.text) + '</p></article>').join('');
      const tools = turn.steps.filter(step => step.kind === 'tool');
      const toolEvent = tools.length ? '<details class="session-event tools" data-session-event="tools"><summary class="session-event-head"><strong>' + tools.length + ' tool call' + (tools.length === 1 ? '' : 's') + '</strong><span>' + turn.toolCallCount + ' observed in turn</span></summary><div class="session-call-list">' + tools.map(toolRow).join('') + '</div></details>' : '';
      const response = '<article class="session-event response' + (turn.response ? '' : ' session-unavailable') + '" data-session-event="responses"><header class="session-event-head"><strong>Assistant response</strong><span>' + (turn.response ? 'retained' : 'unavailable') + '</span></header><div class="session-event-body session-prose"><p>' + escape(turn.response ?? 'Response body was unavailable or removed by privacy filtering.') + '</p></div></article>';
      const summary = turn.messageCount + ' messages · ' + turn.toolCallCount + ' tool calls' + (Number.isFinite(turn.durationMs) ? ' · ' + formatDuration(turn.durationMs) : '');
      return '<section class="session-turn" id="session-' + escape(turn.anchorId) + '"><header class="session-turn-head"><button type="button" class="turn-select" ' + selectionAttrs({ type:'turn', sessionId:session.sessionId, turnIndex:turn.index }) + '>Turn ' + turn.index + '</button><span>' + escape(summary) + '</span></header>' + prompt + notes + toolEvent + response + commitBuckets[index].map(commitEvent).join('') + '</section>';
    }).join('');
    const placedCallIds = new Set(turns.flatMap(turn => turn.steps.filter(step => step.kind === 'tool').map(step => step.callId)));
    const unplacedCalls = session.toolActivity.calls.filter(call => !placedCallIds.has(call.id));
    const unplacedCommits = turns.length ? [] : commits;
    const unplacedFiles = unplacedCalls.length || turns.length === 0 ? session.toolActivity.files : [];
    const unplacedFileEvent = unplacedFiles.length
      ? '<article class="session-event files"><header class="session-event-head"><strong>' + unplacedFiles.length + ' attributed file path' + (unplacedFiles.length === 1 ? '' : 's') + '</strong><span>observed tool evidence</span></header><div class="session-file-list">' + unplacedFiles.map(file => '<button type="button" ' + selectionAttrs({ type:'file', path:file.path, contextSessionId:session.sessionId }) + '>' + escape(file.path) + '</button>').join('') + '</div></article>'
      : '';
    const unplacedToolEvent = unplacedCalls.length
      ? '<details class="session-event tools" data-session-event="tools" open><summary class="session-event-head"><strong>' + unplacedCalls.length + ' unplaced tool call' + (unplacedCalls.length === 1 ? '' : 's') + '</strong><span>retained without a dialogue Turn</span></summary><div class="session-call-list">' + unplacedCalls.map(toolRow).join('') + '</div></details>'
      : '';
    const unplacedMarkup = unplacedToolEvent || unplacedFileEvent || unplacedCommits.length
      ? '<section class="session-turn session-unplaced" id="session-unplaced"><header class="session-turn-head"><strong>Unplaced evidence</strong><span>observed evidence retained outside dialogue</span></header>' + unplacedToolEvent + unplacedFileEvent + unplacedCommits.map(commitEvent).join('') + '</section>'
      : '';
    const filters = rankedTools.slice(0,8).map(([toolName,count]) => '<label class="session-filter subtype"><input type="checkbox" checked data-session-tool-filter="' + escape(toolName) + '"><span>' + escape(toolName) + '</span><em>' + count + '</em></label>').join('');
    const sourceLabel = session.source === 'entire-checkpoint' ? 'Entire checkpoint' : 'Native session';
    const responseCount = session.dialogue?.responseCount ?? turns.filter(turn => turn.response).length;
    const noteCount = session.dialogue?.noteCount ?? turns.reduce((sum,turn) => sum + turn.steps.filter(step => step.kind === 'note').length,0);
    const truncatedNote = session.dialogue?.truncated ? '<span class="session-warning">Turn projection truncated</span>' : '';
    const jumpOptions = turns.map(turn => '<option value="session-' + escape(turn.anchorId) + '">Turn ' + turn.index + '</option>').join('') + (unplacedMarkup ? '<option value="session-unplaced">Unplaced evidence</option>' : '') + commits.map(commit => '<option value="session-commit-' + escape(commit.shortHash) + '">' + escape(commit.shortHash) + '</option>').join('');
    const timeline = turnEvents + unplacedMarkup || '<div class="empty-state">No retained dialogue or observed evidence exists for this session.</div>';
    return { title, html:'<div class="session-shell"><header class="session-titlebar"><div><h2>' + escape(title) + '</h2><div class="session-meta"><span class="session-platform">' + escape(session.platform) + '</span><span>' + escape(session.models.join(', ') || 'model unavailable') + '</span><span>' + formatDuration(session.durationMs) + '</span><span>' + turns.length + ' turns</span><span>' + session.toolActivity.totalCalls + ' tool calls</span><span>' + session.fileEditCount + ' file edits</span><span>' + formatTokens(session.tokenUsage) + '</span>' + truncatedNote + '</div></div><button class="session-context-button" data-session-context>Continuation packet</button></header><div class="session-layout"><main class="session-timeline">' + timeline + '</main><aside class="session-sidebar"><section><h3>Jump to</h3><select class="jump-select" data-session-jump>' + jumpOptions + '</select></section><section><h3>Filters</h3><div class="session-filter-list"><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="prompts"><span>Prompts</span><em>' + turns.length + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="responses"><span>Responses</span><em>' + responseCount + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="intermediate"><span>Intermediate</span><em>' + noteCount + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="commits"><span>Commits</span><em>' + commits.length + '</em></label><label class="session-filter"><input type="checkbox" checked data-session-kind-filter="tools"><span>Tool calls</span><em>' + session.toolActivity.totalCalls + '</em></label>' + filters + '<label class="session-filter subtype"><input type="checkbox" checked data-session-file-filter><span>File paths</span><em>' + session.toolActivity.files.length + '</em></label></div></section><section><h3>Source</h3><div class="session-meta"><span>' + sourceLabel + '</span></div></section></aside></div></div>' };
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

  function openSessionView(item,selection = state.selection,trigger = document.activeElement) {
    const view = sessionViewMarkup(item);
    state.sessionItem = item;
    state.sessionTrigger = trigger;
    document.getElementById('session-view-title').textContent = view.title;
    document.getElementById('session-view-body').innerHTML = view.html;
    document.getElementById('session-view').hidden = false;
    document.getElementById('session-view-close').focus();
    requestAnimationFrame(() => {
      const target = sessionSelectionTarget(selection,item);
      const tools = target?.closest('details.session-event.tools');
      if (tools) tools.open = true;
      target?.scrollIntoView({ block:'center' });
      applySelectionPresentation();
    });
  }

  function closeSessionView() {
    document.getElementById('session-view').hidden = true;
    const trigger = state.sessionTrigger;
    state.sessionTrigger = null;
    if (trigger?.isConnected) trigger.focus();
  }

  function showSwimlaneDetail(bubble) {
    const inspector = bubble.closest('.swimlane-chart-card')?.querySelector('[data-swimlane-inspector]');
    if (!inspector) return;
    const detail = bubble.dataset.detail ? '<code>' + escape(bubble.dataset.detail) + '</code>' : '<span>Input detail withheld or unavailable.</span>';
    const files = bubble.dataset.files ? '<span class="swimlane-inspector-files">' + escape(bubble.dataset.files) + '</span>' : '<span>No repository file attributed.</span>';
    inspector.innerHTML = '<div><strong>' + escape(bubble.dataset.callId + ' · ' + bubble.dataset.action) + '</strong><span>' + escape(bubble.dataset.tool + ' · ' + bubble.dataset.status + ' · ' + bubble.dataset.duration) + '</span></div><div>' + detail + files + '</div>';
  }

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
      session.commitLinks.forEach(link => add({ type:'commit', hash:link.hash, contextSessionId:session.sessionId }));
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
      session?.commitLinks.filter(link => link.overlappingFiles.some(path => paths.has(path))).forEach(link => add({ type:'commit', hash:link.hash, contextSessionId:selection.sessionId }));
      return related;
    }
    if (selection.type === 'tool-call') {
      add({ type:'session', sessionId:selection.sessionId });
      const call = session?.toolActivity.calls.find(item => item.id === selection.callId);
      const turnIndex = callTurnIndex(session,selection.callId);
      if (turnIndex) add({ type:'turn', sessionId:selection.sessionId, turnIndex });
      const paths = new Set(call?.filePaths ?? []);
      paths.forEach(path => add({ type:'file', path, contextSessionId:selection.sessionId }));
      session?.commitLinks.filter(link => link.overlappingFiles.some(path => paths.has(path))).forEach(link => add({ type:'commit', hash:link.hash, contextSessionId:selection.sessionId }));
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
      report.sessions.filter(item => item.commitLinks.some(link => link.hash === selection.hash)).forEach(item => {
        add({ type:'session', sessionId:item.sessionId });
        const link = item.commitLinks.find(candidate => candidate.hash === selection.hash);
        item.toolActivity.calls.filter(call => call.filePaths?.some(path => link.overlappingFiles.includes(path))).forEach(call => add({ type:'tool-call', sessionId:item.sessionId, callId:call.id }));
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
      return { ...base,
        title:session?.locator ?? selection.sessionId,
        kind:link?.evidenceKind ?? 'unmapped', strength:link?.strength ?? 'contextual', source:link?.source ?? session?.source ?? 'native-session',
        facts:link?.facts ?? [session?.toolActivity.totalCalls + ' normalized Tool Calls are retained.',session?.toolActivity.files.length + ' repository paths are attributed.'],
        limitations:link?.limitations ?? ['No reviewed Story or correlated Commit relationship is retained for this Session.'],
        path:story ? [story.title,link.evidenceKind + '-for',session.locator] : commit ? [session.locator,link.evidenceKind,commit.shortHash] : [session?.locator ?? selection.sessionId,'unmapped','No delivery owner'],
      };
    }
    if (selection.type === 'turn') {
      const turn = session?.dialogue?.turns?.find(item => item.index === selection.turnIndex);
      return { ...base,
        title:'Turn ' + selection.turnIndex, source:'session-dialogue',
        facts:[(turn?.toolCallCount ?? 0) + ' Tool Calls are observed in this Turn.',(turn?.messageCount ?? 0) + ' retained messages define its dialogue window.'],
        limitations:['Turn membership places activity in dialogue order; it does not prove which later Commit contains the result.'],
        path:[session?.locator ?? selection.sessionId,'observed-in','Turn ' + selection.turnIndex],
      };
    }
    if (selection.type === 'tool-call') {
      const call = session?.toolActivity.calls.find(item => item.id === selection.callId);
      const turnIndex = callTurnIndex(session,selection.callId);
      const path = [session?.locator ?? selection.sessionId];
      if (turnIndex) path.push('observed-in','Turn ' + turnIndex);
      path.push('observed',call?.id + ' · ' + call?.actionLabel);
      if (call?.filePaths?.[0]) path.push(call.operation ?? 'touched',call.filePaths[0]);
      return { ...base,
        title:call ? call.id + ' · ' + call.actionLabel : selection.callId,
        source:'NormalizedToolActivityV1',
        facts:[call?.toolName ? 'Native tool: ' + call.toolName + '.' : null,call?.status ? 'Observed status: ' + call.status + '.' : null,call?.durationStatus === 'observed' ? 'Observed duration: ' + call.durationMs + ' ms.' : 'Duration evidence is unavailable.',...(call?.filePaths?.map(path => 'Attributed path: ' + path + '.') ?? [])].filter(Boolean),
        limitations:['A Tool Call observation proves retained activity metadata, not that a later Commit contains or was authored by that activity.'],
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

  function updateUrl() {
    const url = new URL(location.href);
    ['feature','date','story','session','context-session','turn','call','file','commit'].forEach(key => url.searchParams.delete(key));
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
    history.replaceState(null,'',url);
  }

  function applySelectionPresentation() {
    const selectedKey = selectionKey(state.selection);
    const related = state.selection ? relatedSelections(state.selection) : new Map();
    document.body.classList.toggle('has-evidence-selection',Boolean(selectedKey));
    document.querySelectorAll('[data-selectable]').forEach(element => {
      const key = selectionKey(descriptorFromElement(element));
      element.classList.toggle('selection-selected',key === selectedKey);
      element.classList.toggle('selection-related',Boolean(selectedKey) && related.has(key));
      element.classList.toggle('selection-unrelated',Boolean(selectedKey) && key !== selectedKey && !related.has(key));
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
    if (!state.selection) {
      drawer.hidden = true;
      app.classList.remove('drawer-open');
      if (app.dataset.drawerCollapsedPicker === 'true') setPickerCollapsed(false);
      return;
    }
    const description = describeSelection(state.selection);
    const priorities = {
      story:{ session:0, commit:1, turn:2, file:3, 'tool-call':4 },
      session:{ story:0, commit:1, turn:2, file:3, 'tool-call':4 },
      turn:{ 'tool-call':0, file:1, commit:2, session:3, story:4 },
      'tool-call':{ turn:0, file:1, commit:2, session:3, story:4 },
      file:{ commit:0, session:1, 'tool-call':2, story:3, turn:4 },
      commit:{ file:0, session:1, story:2, 'tool-call':3, turn:4 },
    };
    const relatedPriority = priorities[state.selection.type] ?? {};
    const related = [...relatedSelections(state.selection).values()]
      .sort((left,right) => (relatedPriority[left.type] ?? 9) - (relatedPriority[right.type] ?? 9) || descriptorLabel(left).localeCompare(descriptorLabel(right)))
      .slice(0,10);
    const path = description.path.map((label,index) => '<div class="evidence-path-row' + (index % 2 ? ' edge' : '') + '"><span>' + escape(label) + '</span></div>').join('');
    const facts = description.facts.length ? '<ul>' + description.facts.map(fact => '<li>' + escape(fact) + '</li>').join('') + '</ul>' : '<div class="evidence-source">No additional retained facts.</div>';
    const limitations = description.limitations.map(item => escape(item)).join(' ');
    const relatedMarkup = related.length ? related.map(item => '<button type="button" class="evidence-related" ' + selectionAttrs(item) + '><span>' + escape(descriptorLabel(item)) + '</span><em>' + escape(item.type) + '</em></button>').join('') : '<div class="evidence-source">No related retained objects.</div>';
    document.getElementById('evidence-drawer-title').textContent = description.title;
    document.getElementById('evidence-drawer-body').innerHTML = '<div class="evidence-overview">' + evidence(description.kind) + '<code>' + escape(description.locator) + '</code></div><section class="evidence-section"><h3>Evidence path</h3><div class="evidence-path">' + path + '</div></section><section class="evidence-section"><h3>Why linked · ' + escape(description.strength) + '</h3>' + facts + '</section><section class="evidence-section"><h3>Related objects</h3><div class="evidence-related-list">' + relatedMarkup + '</div></section><section class="evidence-section"><h3>Limitations</h3><div class="evidence-limitations">' + limitations + '</div></section><section class="evidence-section"><h3>Source</h3><div class="evidence-source">' + escape(description.source) + '</div><div class="evidence-copy-status" data-evidence-copy-status aria-live="polite"></div></section>';
    const open = document.querySelector('[data-open-evidence-session]');
    const session = sessionForSelection(state.selection);
    open.hidden = !session;
    open.dataset.sessionId = session?.sessionId ?? '';
    drawer.hidden = false;
    app.classList.add('drawer-open');
    if (innerWidth > 760 && innerWidth < 1200 && !app.classList.contains('picker-collapsed')) setPickerCollapsed(true,{ automatic:true });
  }

  function setSelection(selection,{ updateHistory = true } = {}) {
    state.selection = selection;
    renderEvidenceDrawer();
    applySelectionPresentation();
    if (updateHistory) updateUrl();
  }

  function clearSelection(options) {
    setSelection(null,options);
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
    document.querySelectorAll('[data-tree-item][aria-expanded]').forEach(item => setTreeItemExpanded(item,false));
    let item = document.querySelector('[data-feature-id="' + CSS.escape(state.scope ?? '') + '"]')?.closest('[data-tree-item]') ?? null;
    while (item) {
      setTreeItemExpanded(item,true);
      item = item.parentElement?.closest('[data-tree-item]') ?? null;
    }
  }

  document.addEventListener('click', event => {
    const bubble = event.target.closest('.swimlane-bubble');
    if (bubble) {
      showSwimlaneDetail(bubble);
      setSelection(descriptorFromElement(bubble));
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
      state.scope = feature.dataset.featureId;
      setTreeItemExpanded(feature.closest('[data-tree-item]'),true);
      setMode('feature');
      if (feature.dataset.selectionType === 'story') setSelection(descriptorFromElement(feature));
      return;
    }
    const pickerToggle = event.target.closest('[data-toggle-picker]');
    if (pickerToggle) {
      const app = document.querySelector('.app');
      const collapsed = !app.classList.contains('picker-collapsed');
      setPickerCollapsed(collapsed);
      return;
    }
    const date = event.target.closest('[data-date]');
    if (date) { state.scope = date.dataset.date; setMode('date'); return; }
    const openSession = event.target.closest('[data-open-session]');
    if (openSession) {
      const item = state.items?.[Number(openSession.dataset.openSession)];
      if (item?.session) openSessionView(item,state.selection,openSession);
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
    const selectable = event.target.closest('[data-selectable]');
    if (selectable) {
      setSelection(descriptorFromElement(selectable));
      return;
    }
    if (event.target.closest('[data-close-session]')) {
      closeSessionView();
      return;
    }
    if (event.target.closest('[data-close-evidence]')) {
      clearSelection();
      return;
    }
    const openEvidenceSession = event.target.closest('[data-open-evidence-session]');
    if (openEvidenceSession) {
      const session = bySession.get(openEvidenceSession.dataset.sessionId);
      const item = state.items?.find(candidate => candidate.session?.sessionId === session?.sessionId)
        ?? (session ? { story:null, session, link:{ evidenceKind:'contextual', confidence:'drawer' }, date:null } : null);
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
      requestAnimationFrame(() => {
        initializeSwimlanes(target);
        applySelectionPresentation();
        target.querySelector('.selection-selected')?.scrollIntoView({ block:'nearest', inline:'center' });
      });
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
    const prompt = grid.querySelector('.prompt-lane').getBoundingClientRect();
    const delivery = grid.querySelector('.delivery-lane').getBoundingClientRect();
    state.resize = { handle, grid, kind:handle.dataset.resizeLane, startX:event.clientX, promptWidth:prompt.width, deliveryWidth:delivery.width };
    handle.classList.add('resizing');
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  document.addEventListener('pointermove', event => {
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

  document.addEventListener('pointerup', () => {
    state.resize?.handle.classList.remove('resizing');
    state.resize = null;
  });

  document.addEventListener('keydown', event => {
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
      else if (!document.getElementById('session-view').hidden) closeSessionView();
      else if (state.selection) clearSelection();
    }
  });
  state.selection = selectionFromUrl();
  initializeTree();
  setMode(state.mode,{ preserveSelection:true, updateHistory:false });
  if (state.selection) setSelection(state.selection,{ updateHistory:false });
})();

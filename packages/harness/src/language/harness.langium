// Harness assembly language, v0.2 surface.
//
// The DSL describes how an agent run works, host-neutrally: which harness
// assembles which workflow and agent roles, which capabilities (skills,
// tools, MCP connections) each role needs, and which runtimes the harness
// deploys to. Adapters map capabilities onto host-native assets via
// `binding` mechanisms in a host namespace (`qoder.plugin`, `pi.extension`);
// the core language defines no generic plugin. Revisions and resolution
// reports are resolver outputs, not authored syntax.
grammar Harness

entry HarnessDocument:
    (elements+=Declaration)*;

Declaration:
    HarnessDeclaration | WorkflowDeclaration | CapabilityDeclaration
    | RuntimeDeclaration | TargetDeclaration | CapabilityBinding;

// A complete assembly: the workflow that drives the run, the logical agent
// roles that participate, and run configuration. Runtimes are chosen at
// deployment via `target`, never inside the harness itself.
HarnessDeclaration:
    'harness' name=ID '{'
        'workflow' workflow=[WorkflowDeclaration:ID]
        (agents+=AgentDeclaration)*
        ('configure' '{' (settings+=ConfigEntry)* '}')?
    '}';

// A logical role inside a harness (`author`, `verifier`). Hosts such as
// Qoder or Pi are runtimes, not agents.
AgentDeclaration:
    'agent' name=ID '{'
        (requirements+=CapabilityUse)*
    '}';

// One capability requirement of an agent. The verb states the capability
// kind: `use skill`, `require tool`, `connect mcp`. Tools referenced without
// a declaration become implicit atomic contracts; skills and MCP entries
// must be declared because they carry source or connection facts. The
// optional block keeps the v0.1 degradation ladder: a bare requirement asks
// for the `advisory` floor with `on-degrade report`.
CapabilityUse:
    ( verb='use' 'skill' | verb='require' 'tool' | verb='connect' 'mcp' )
    capability=QualifiedName
    ('{'
        ('preferred' preferred=Strength)?
        ('minimum' minimum=Strength)?
        ('on-degrade' onDegrade=DegradePolicy)?
    '}')?;

// Control flow. Declarative graphs list agent-to-agent edges, event routes,
// and stop conditions; programmatic workflows delegate control to a program
// in a named language. A workflow declares exactly one of the two forms
// (enforced semantically for precise diagnostics).
WorkflowDeclaration:
    'workflow' name=ID '{'
        (program=ProgramBody)?
        (statements+=WorkflowStatement)*
    '}';

ProgramBody:
    'program' language=ID entry=STRING;

WorkflowStatement:
    EdgeStatement | EventStatement | StopStatement;

EdgeStatement:
    from=ID '->' to=ID;

EventStatement:
    'on' agent=ID '.' outcome=ID '->' to=ID;

StopStatement:
    'stop' 'when' agent=ID '.' outcome=ID;

CapabilityDeclaration:
    SkillDeclaration | ToolDeclaration | McpDeclaration;

// Progressive knowledge per the Agent Skills standard: either a `source`
// directory, or inline `description` guidance, or both.
SkillDeclaration:
    'skill' name=ID '{'
        ('source' source=STRING)?
        ('description' description=STRING)?
        ('permissions' '{' (permissions+=PermissionRule)* '}')?
    '}';

// An atomic callable capability with input/output identifiers. Dotted names
// (`workspace.read`) namespace tools by capability surface.
ToolDeclaration:
    'tool' name=QualifiedName '{'
        ('description' description=STRING)?
        ('input' '{' (inputs+=ID)* '}')?
        ('output' '{' (outputs+=ID)* '}')?
        ('permissions' '{' (permissions+=PermissionRule)* '}')?
    '}';

// A capability connection, not a tool: what the MCP server is reached over.
// Which tools/resources/prompts it provides is discovered at runtime.
McpDeclaration:
    'mcp' name=ID '{'
        'transport' transport=Transport
        ('url' url=McpEndpoint)?
        ('command' command=STRING)?
    '}';

Transport returns string:
    'stdio' | 'http' | 'sse';

McpEndpoint:
    {infer EnvEndpoint} 'env' '.' variable=ID
  | {infer LiteralEndpoint} value=STRING;

// A concrete host (Qoder, Pi, DeepSeek Harness, Prime Agent): its adapter
// package and how it exposes capabilities to the model — classic tool
// calling, or programmatic calling in a host language (Prime's persistent
// IPython, DeepSeek's TypeScript plugin runtime).
RuntimeDeclaration:
    'runtime' name=ID '{'
        'adapter' adapter=STRING
        ('execution' execution=ExecutionSpec)?
    '}';

ExecutionSpec:
    {infer ToolCallingExecution} style='tool-calling'
  | {infer ProgrammaticExecution} 'programmatic' '.' language=ID
        ('{' (options+=ExecutionOption)* '}')?;

ExecutionOption:
    key=ID value=ID;

// Deployment statement: this document's harnesses deploy to the named
// runtime. `uses adapter.<id>` is shorthand when no runtime block exists;
// a declared runtime already owns its adapter.
TargetDeclaration:
    'target' runtime=ID ('uses' 'adapter' '.' adapter=ID)?;

// Adapter-layer mapping of one capability onto one or more runtimes. The
// mechanism is a dotted name so host-native assets stay in the host's own
// namespace (`qoder.plugin`, `pi.extension`, `deepseek.plugin`,
// `prime.python-skill`). An omitted binding is prompt guidance at
// `advisory`, the v0.2 materialization floor.
CapabilityBinding:
    'binding' capability=QualifiedName 'for'
        ( runtimes+=ID | '[' runtimes+=ID (',' runtimes+=ID)* ']' ) '{'
        ('mechanism' mechanism=QualifiedName)?
        ('strength' strength=Strength)?
        ('notes' notes=STRING)?
    '}';

Strength returns string:
    'unsupported' | 'advisory' | 'wired' | 'enforced';

DegradePolicy returns string:
    'fail' | 'report';

PermissionRule:
    domain=PermissionDomain access=PermissionAccess;

PermissionDomain returns string:
    'workspace' | 'process' | 'network' | 'model';

PermissionAccess returns string:
    'read' | 'write' | 'allow' | 'deny';

ConfigEntry:
    key=QualifiedName '=' value=ConfigValue;

// Dotted names appear as tool ids, binding mechanisms, and configuration
// keys. Their segments accept the language's non-structural keywords as soft
// keywords, so `workspace.read`, `process.exec`, or `runtime.timeout` stay
// legal even though `workspace`, `process`, and `runtime` are keywords
// elsewhere in the grammar.
QualifiedName returns string:
    NameSegment ('.' NameSegment)*;

NameSegment returns string:
    ID | 'workspace' | 'process' | 'network' | 'model' | 'read' | 'write'
    | 'allow' | 'deny' | 'env' | 'url' | 'command' | 'source' | 'description'
    | 'transport' | 'adapter' | 'execution' | 'program' | 'runtime' | 'target'
    | 'agent' | 'skill' | 'tool' | 'mcp' | 'workflow' | 'harness' | 'input'
    | 'output' | 'mechanism' | 'strength' | 'notes' | 'configure' | 'stdio'
    | 'http' | 'sse';

ConfigValue:
    IntLiteral | DurationLiteral | StringLiteral | BooleanLiteral;

IntLiteral:
    value=INT;

DurationLiteral:
    value=DURATION;

StringLiteral:
    value=STRING;

BooleanLiteral:
    {infer BooleanLiteral} (value?='true' | 'false');

terminal DURATION: /[0-9]+(ms|s|m|h)/;
terminal INT returns number: /[0-9]+/;
terminal ID: /[_a-zA-Z][\w-]*/;
terminal STRING returns string: /"[^"]*"/;

hidden terminal WS: /\s+/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;

// Harness assembly language, v0.1 surface.
//
// The DSL declares what a harness is assembled from (contracts, bindings,
// plugins, compositions). Revisions and resolution reports are resolver
// outputs, not authored syntax.
grammar Harness

entry HarnessDocument:
    (elements+=Declaration)*;

Declaration:
    ComponentContract | TargetBinding | PluginDeclaration | CompositionDeclaration;

// A target-independent capability contract: what a capability is,
// what it consumes and produces, and which permissions it asks for.
ComponentContract:
    'component' name=ID '{'
        'kind' kind=ComponentKind
        ('description' description=STRING)?
        ('input' '{' (inputs+=ID)* '}')?
        ('output' '{' (outputs+=ID)* '}')?
        ('permissions' '{' (permissions+=PermissionRule)* '}')?
    '}';

ComponentKind returns string:
    'skill' | 'tool' | 'program' | 'workflow' | 'hook' | 'policy' | 'observer' | 'ui';

PermissionRule:
    domain=PermissionDomain access=PermissionAccess;

PermissionDomain returns string:
    'workspace' | 'process' | 'network' | 'model';

PermissionAccess returns string:
    'read' | 'write' | 'allow' | 'deny';

// How a component is realized on one or more concrete hosts, and how
// strong the realized guarantee is. `for [a, b]` declares the same
// mechanism/strength on several hosts at once. `mechanism` and `strength`
// are optional: an omitted binding is prompt guidance at `advisory`, the
// v0.1 materialization floor, so authors only spell out a binding to
// declare a stronger future mechanism or an explicit `unsupported`.
TargetBinding:
    'binding' component=[ComponentContract:ID] 'for'
        ( hosts+=ID | '[' hosts+=ID (',' hosts+=ID)* ']' ) '{'
        ('mechanism' mechanism=ID)?
        ('strength' strength=Strength)?
        ('notes' notes=STRING)?
    '}';

Strength returns string:
    'unsupported' | 'advisory' | 'wired' | 'enforced';

// Distribution boundary: which contracts a package provides.
// Bindings for provided components are attached by the compiler.
PluginDeclaration:
    'plugin' name=ID '{'
        'version' version=STRING
        'provides' '[' provides+=ComponentRef (',' provides+=ComponentRef)* ']'
    '}';

ComponentRef:
    'component' '.' component=[ComponentContract:ID];

// Desired assembly for one run target. Resolving a composition against
// a registry produces an immutable revision plus a resolution report.
//
// `extends` inherits the base composition's target, includes, requirements,
// and configuration; the child overrides `target` and appends its own
// members. `include` is optional: a composition may `require` components
// directly, without wrapping them in a plugin, in which case they
// materialize as advisory prompt guidance.
CompositionDeclaration:
    'composition' name=ID ('extends' base=[CompositionDeclaration:ID])? '{'
        ('target' target=ID)?
        ('include' '[' includes+=PluginRequirement (',' includes+=PluginRequirement)* ']')?
        (requirements+=CapabilityRequirement)*
        ('configure' '{' (settings+=ConfigEntry)* '}')?
    '}';

PluginRequirement:
    'plugin' '.' plugin=[PluginDeclaration:ID] range=VERSION_RANGE;

// A bare `require component` is the common case: it asks for the component
// at the `advisory` floor with `on-degrade report`. The optional block
// raises the floor (`minimum`), states a `preferred` ceiling, or makes
// degradation fatal (`on-degrade fail`).
CapabilityRequirement:
    'require' component=[ComponentContract:ID] ('{'
        ('preferred' preferred=Strength)?
        ('minimum' minimum=Strength)?
        ('on-degrade' onDegrade=DegradePolicy)?
    '}')?;

DegradePolicy returns string:
    'fail' | 'report';

ConfigEntry:
    key=DottedName '=' value=ConfigValue;

DottedName returns string:
    ID ('.' ID)*;

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
terminal VERSION_RANGE: /@[~^]?[0-9][0-9a-zA-Z.+*-]*/;
terminal ID: /[_a-zA-Z][\w-]*/;
terminal STRING returns string: /"[^"]*"/;

hidden terminal WS: /\s+/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;

import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
import useBaseUrl from "@docusaurus/useBaseUrl";
import Layout from "@theme/Layout";
import clsx from "clsx";

import styles from "./index.module.css";

function loopDimensions() {
  return [
    {
      title: translate({
        id: "homepage.dimensions.taskUnderstanding.title",
        message: "Task Understanding",
      }),
      question: translate({
        id: "homepage.dimensions.taskUnderstanding.question",
        message: "Does the agent know the goal and what \u201cdone\u201d means?",
      }),
    },
    {
      title: translate({
        id: "homepage.dimensions.controlledExecution.title",
        message: "Controlled Execution",
      }),
      question: translate({
        id: "homepage.dimensions.controlledExecution.question",
        message: "Is the work on supported, repeatable paths?",
      }),
    },
    {
      title: translate({
        id: "homepage.dimensions.changeValidation.title",
        message: "Change Validation",
      }),
      question: translate({
        id: "homepage.dimensions.changeValidation.question",
        message: "Is there evidence the change actually works?",
      }),
    },
    {
      title: translate({
        id: "homepage.dimensions.reliableDelivery.title",
        message: "Reliable Delivery",
      }),
      question: translate({
        id: "homepage.dimensions.reliableDelivery.question",
        message: "Does AI speed bypass quality checks or acceptance?",
      }),
    },
    {
      title: translate({
        id: "homepage.dimensions.learningCapture.title",
        message: "Learning Capture",
      }),
      question: translate({
        id: "homepage.dimensions.learningCapture.question",
        message: "Does the next task benefit from this one?",
      }),
    },
  ];
}

function hosts() {
  return [
    {
      name: "Claude Code",
      setup: translate({
        id: "homepage.hosts.claudeCode.setup",
        message: "Add the repository marketplace, then install the plugin.",
      }),
      anchor: "claude-code",
    },
    {
      name: "Codex",
      setup: translate({
        id: "homepage.hosts.codex.setup",
        message: "Add the Git marketplace from Desktop settings or the CLI.",
      }),
      anchor: "codex",
    },
    {
      name: "Qoder",
      setup: translate({
        id: "homepage.hosts.qoder.setup",
        message:
          "Built into Qoder Desktop; Qoder CLI can reuse it or install separately.",
      }),
      anchor: "qoder",
    },
    {
      name: "Cursor",
      setup: translate({
        id: "homepage.hosts.cursor.setup",
        message: "Load the source-local plugin with --plugin-dir.",
      }),
      anchor: "cursor",
    },
    {
      name: "Qwen Code",
      setup: translate({
        id: "homepage.hosts.qwenCode.setup",
        message: "Install as a Qwen Code extension.",
      }),
      anchor: "qwen-code",
    },
    {
      name: "GitHub Copilot",
      setup: translate({
        id: "homepage.hosts.githubCopilot.setup",
        message: "Add the marketplace and install the plugin.",
      }),
      anchor: "github-copilot",
    },
  ];
}

function Hero() {
  return (
    <header className={clsx("hero hero--primary", styles.hero)}>
      <div className="container">
        <h1 className="hero__title">Better Harness</h1>
        <p className="hero__subtitle">
          <Translate id="homepage.hero.tagline">
            See how your AI coding workflow works—and make it better, one step
            at a time.
          </Translate>
        </p>
        <p className={styles.heroLead}>
          <Translate id="homepage.hero.lead">
            Better Harness reviews how coding agents understand tasks, make
            changes, verify results, deliver safely, and learn—then shows what
            to improve next, with every finding tied to visible evidence.
          </Translate>
        </p>
        <div className={styles.buttons}>
          <Link
            className={clsx("button button--lg", styles.heroPrimaryButton)}
            to="/docs/installation"
          >
            <Translate id="homepage.hero.getStarted">Get started</Translate>
          </Link>
          <a
            className={clsx("button button--lg", styles.heroSecondaryButton)}
            href={useBaseUrl("/demo/better-harness-report/")}
          >
            <Translate id="homepage.hero.viewDemo">
              View sample report
            </Translate>
          </a>
        </div>
      </div>
    </header>
  );
}

function LiveDemo() {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2>
          <Translate id="homepage.demo.title">See it in action</Translate>
        </h2>
        <p>
          <Translate
            id="homepage.demo.intro"
            values={{
              entrypointLink: (
                <Link to="/docs/installation">
                  <Translate id="homepage.demo.entrypointLabel">
                    entrypoint documented for your host
                  </Translate>
                </Link>
              ),
            }}
          >
            {
              "Use the {entrypointLink} to review the current task and its surrounding project Harness. The report keeps missing evidence explicit and turns supported gaps into prioritized findings with an impact, expected output, scoped repair, and acceptance checks."
            }
          </Translate>
        </p>
        <p className={styles.demoFrame}>
          <a href={useBaseUrl("/demo/better-harness-report/")}>
            <img
              src={useBaseUrl("/demo/better-harness-findings-report.png")}
              alt={translate({
                id: "homepage.demo.reportAlt",
                message:
                  "Better Harness sample HTML report showing an evidence-bounded finding with its impact, expected output, scoped AI fix, and acceptance checks",
              })}
              width="1280"
              height="950"
              loading="lazy"
              decoding="async"
            />
          </a>
        </p>
        <p className={styles.demoCaption}>
          <a href={useBaseUrl("/demo/better-harness-report/")}>
            <Translate id="homepage.demo.openReport">
              Open the self-contained English sample report
            </Translate>
          </a>
        </p>
        <p className={styles.demoFrame}>
          <img
            src={useBaseUrl("/demo/twenty-history.png")}
            alt={translate({
              id: "homepage.demo.historyAlt",
              message:
                "Static final frame of Better Harness report history showing five Agent Work Loop dimensions over time",
            })}
            width="1351"
            height="955"
            loading="lazy"
            decoding="async"
          />
        </p>
        <p className={styles.demoCaption}>
          <Translate id="homepage.demo.historyCaption">
            This static final frame summarizes historical Harness reports. It
            shows recorded trends, not causal proof of improvement.
          </Translate>
        </p>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className={clsx(styles.section, styles.sectionAlt)}>
      <div className="container">
        <h2>
          <Translate id="homepage.how.title">
            How Better Harness works
          </Translate>
        </h2>
        <p>
          <Translate
            id="homepage.how.intro"
            values={{
              workLoopLink: (
                <Link to="/docs/concepts/agent-work-loop">
                  <Translate id="homepage.how.workLoopLabel">
                    Agent Work Loop
                  </Translate>
                </Link>
              ),
            }}
          >
            {
              "Better Harness combines feedforward guides (AGENTS.md, specs, Skills, acceptance criteria) with feedback sensors (linters, tests, Hooks, review agents), and evaluates five parts of delivery—the {workLoopLink}:"
            }
          </Translate>
        </p>
        <div className={styles.dimensionGrid}>
          {loopDimensions().map((dimension) => (
            <div key={dimension.title} className={styles.dimensionCard}>
              <h3>{dimension.title}</h3>
              <p>{dimension.question}</p>
            </div>
          ))}
        </div>
        <p className={styles.demoFrame}>
          <img
            src={useBaseUrl("/img/better-harness-architecture-en.svg")}
            alt={translate({
              id: "homepage.how.architectureAlt",
              message:
                "Better Harness architecture: six public Quickstart hosts plus Pi at the capability layer feed three independent evidence agents, unified analysis, host-neutral outputs, and repair",
            })}
            width="1800"
            height="1360"
            loading="lazy"
            decoding="async"
          />
        </p>
        <p className={styles.demoCaption}>
          <Translate id="homepage.how.architectureCaption">
            Seven capability-level host adapters feed the same evidence
            pipeline. Six have public Quickstart paths; Pi remains pending a
            full report-loop smoke.
          </Translate>
        </p>
      </div>
    </section>
  );
}

function QuickStart() {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2>
          <Translate id="homepage.quickstart.title">Quick start</Translate>
        </h2>
        <p>
          <Translate id="homepage.quickstart.intro">
            Choose your coding agent to see its exact installation,
            verification, and invocation steps.
          </Translate>
        </p>
        <div className={styles.hostGrid}>
          {hosts().map((host) => (
            <Link
              key={host.name}
              className={styles.hostCard}
              to={`/docs/installation?host=${host.anchor}#${host.anchor}`}
            >
              <h3>{host.name}</h3>
              <p>{host.setup}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <Layout
      description={translate({
        id: "homepage.meta.description",
        message:
          "Better Harness reviews how coding agents understand tasks, make changes, verify results, deliver safely, and learn - with every finding tied to visible evidence.",
      })}
    >
      <Hero />
      <main>
        <QuickStart />
        <LiveDemo />
        <HowItWorks />
      </main>
    </Layout>
  );
}

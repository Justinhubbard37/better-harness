import type { ValidationAcceptor, ValidationChecks } from "langium";
import {
  type CapabilityRequirement,
  type HarnessAstType,
  type HarnessDocument,
  isTargetBinding,
} from "./generated/ast.js";
import type { HarnessServices } from "./harness-module.js";

export const STRENGTH_ORDER = ["unsupported", "advisory", "wired", "enforced"] as const;

export function strengthIndex(strength: string): number {
  return STRENGTH_ORDER.indexOf(strength as (typeof STRENGTH_ORDER)[number]);
}

export function registerValidationChecks(services: HarnessServices): void {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.HarnessValidator;
  const checks: ValidationChecks<HarnessAstType> = {
    CapabilityRequirement: validator.checkPreferredNotBelowMinimum,
    HarnessDocument: validator.checkUniqueBindingPerHost,
  };
  registry.register(checks, validator);
}

export class HarnessValidator {
  checkPreferredNotBelowMinimum(requirement: CapabilityRequirement, accept: ValidationAcceptor): void {
    if (requirement.preferred === undefined || requirement.minimum === undefined) {
      return;
    }
    if (strengthIndex(requirement.preferred) < strengthIndex(requirement.minimum)) {
      accept(
        "error",
        `Preferred strength '${requirement.preferred}' is below minimum '${requirement.minimum}'.`,
        { node: requirement, property: "preferred" },
      );
    }
  }

  checkUniqueBindingPerHost(document: HarnessDocument, accept: ValidationAcceptor): void {
    const seen = new Set<string>();
    for (const element of document.elements) {
      if (!isTargetBinding(element)) {
        continue;
      }
      for (const host of element.hosts) {
        const key = `${element.component.$refText}::${host}`;
        if (seen.has(key)) {
          accept(
            "error",
            `Duplicate binding for component '${element.component.$refText}' on host '${host}'.`,
            { node: element, property: "hosts" },
          );
        }
        seen.add(key);
      }
    }
  }
}

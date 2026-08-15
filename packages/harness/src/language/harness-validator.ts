import type { ValidationAcceptor, ValidationChecks } from "langium";
import {
  type CapabilityUse,
  type HarnessAstType,
  type HarnessDocument,
  isCapabilityBinding,
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
    CapabilityUse: validator.checkPreferredNotBelowMinimum,
    HarnessDocument: validator.checkUniqueBindingPerRuntime,
  };
  registry.register(checks, validator);
}

export class HarnessValidator {
  checkPreferredNotBelowMinimum(requirement: CapabilityUse, accept: ValidationAcceptor): void {
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

  checkUniqueBindingPerRuntime(document: HarnessDocument, accept: ValidationAcceptor): void {
    const seen = new Set<string>();
    for (const element of document.elements) {
      if (!isCapabilityBinding(element)) {
        continue;
      }
      for (const runtime of element.runtimes) {
        const key = `${element.capability}::${runtime}`;
        if (seen.has(key)) {
          accept(
            "error",
            `Duplicate binding for capability '${element.capability}' on runtime '${runtime}'.`,
            { node: element, property: "runtimes" },
          );
        }
        seen.add(key);
      }
    }
  }
}

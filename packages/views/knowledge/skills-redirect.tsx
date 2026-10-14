"use client";

import { useEffect } from "react";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../navigation";

export function SkillsRedirect() {
  const paths = useWorkspacePaths();
  const { replace } = useNavigation();
  const destination = paths.knowledge("skills");
  useEffect(() => {
    replace(destination);
  }, [replace, destination]);
  return null;
}

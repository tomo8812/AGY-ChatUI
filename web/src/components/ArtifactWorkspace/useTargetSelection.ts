import { useLayoutEffect, useRef } from 'react';

export function useTargetSelection(beginWorkspaceSelection: () => () => boolean, scope: string) {
  const generation = useRef(0);
  useLayoutEffect(() => () => { generation.current++; }, [scope]);
  return {
    invalidate: () => { generation.current++; },
    begin: () => {
      const validWorkspace = beginWorkspaceSelection();
      const selected = ++generation.current;
      return () => selected === generation.current && validWorkspace();
    },
  };
}

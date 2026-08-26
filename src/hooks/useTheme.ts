import { useState, useEffect } from 'react';
import { bitable } from '@lark-base-open/js-sdk';

/** 跟随飞书多维表格的主题（light/dark） */
export function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    bitable.bridge
      .getTheme()
      .then((t: string) => setTheme(t === 'dark' ? 'dark' : 'light'))
      .catch(() => setTheme('light'));

    const off = bitable.bridge.onThemeChange?.((ev: any) =>
      setTheme(
        typeof ev === 'string'
          ? ev === 'dark'
            ? 'dark'
            : 'light'
          : ev?.theme === 'dark'
            ? 'dark'
            : 'light'
      )
    );
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  return theme;
}

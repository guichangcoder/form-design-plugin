import React, { useState } from 'react';
import { Button, Typography } from '@douyinfe/semi-ui';
import { IconCopy, IconTick } from '@douyinfe/semi-icons';
import { toast } from '../../utils/toast';

/** 部署服务地址：取当前页面 origin（开发/生产都适用） */
function getServiceUrl(): string {
  try {
    return window.location.origin + window.location.pathname;
  } catch {
    return '';
  }
}

/**
 * 保存配置后展示的「添加到应用模式」引导卡。
 * 说明：多维表格插件 SDK 没有"程序化把插件加入应用模式页面"的 API，
 * 这一步必须由用户在飞书页面编辑器里手动做一次（添加自定义插件 → 填服务地址）。
 * 本组件把这一步做成「一键复制地址 + 三步指引」，并把 HTTPS 限制提前提示出来。
 */
export function AddToAppHint({ onDismiss }: { onDismiss: () => void }) {
  const url = getServiceUrl();
  const isHttps = url.startsWith('https://');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast('服务地址已复制', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('复制失败，请手动选择地址复制', 'error');
    }
  };

  return (
    <div className="add-to-app-hint">
      <div className="aah-head">
        <span className="aah-badge">✓ 配置已保存</span>
        <span className="aah-title">把表单添加到「应用模式」页面</span>
      </div>
      <p className="aah-desc">
        配置已写入多维表格云端（同一份表格下的所有插件实例共享）。把它加进应用模式的「仪表盘页面」，团队成员就能在应用里直接填表。
      </p>

      <div className="aah-url-row">
        <code className="aah-url" title={url}>
          {url || '（无法获取当前地址）'}
        </code>
        <Button theme="solid" size="small" icon={copied ? <IconTick /> : <IconCopy />} onClick={copy}>
          {copied ? '已复制' : '复制地址'}
        </Button>
      </div>

      {!isHttps && (
        <div className="aah-warn">
          ⚠ 当前地址是 <b>http</b>，而应用模式页面是 <b>https</b>，浏览器会以"混合内容"拦截加载。
          正式使用前需把部署改为 <b>https</b>（绑定域名 + 证书）。
        </div>
      )}

      <ol className="aah-steps">
        <li>
          打开多维表格 → 左下角「<b>应用</b>」进入应用模式，新建或编辑一个「<b>仪表盘</b>」页面。
        </li>
        <li>
          进入页面画布 → 点「<b>+ 添加组件</b>」→ 选「<b>插件</b>」→「<b>更多</b>」进入插件市场。
        </li>
        <li>
          点插件市场左下角「<b>添加自定义插件</b>」→ 粘贴上面的服务地址 → 确定。插件即作为仪表盘页面组件出现，可拖拽调整大小。
        </li>
      </ol>

      <div className="aah-foot">
        <Typography.Text type="tertiary" size="small">
          添加后该页面直接显示填写表单（读取同一份配置，无需再配一次）。
        </Typography.Text>
        <Button theme="borderless" size="small" onClick={onDismiss}>
          我已添加 / 暂不需要
        </Button>
      </div>
    </div>
  );
}

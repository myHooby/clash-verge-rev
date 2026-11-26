import {
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog } from '@/components/base'
import { useSpeedRunStatus } from '@/hooks/use-speed-state'
import { useVerge } from '@/hooks/use-verge'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import speedManager, {
  SpeedTestBusyError,
  SPEED_CONCURRENCY_OPTIONS,
  getStoredSpeedTestOptions,
  storeSpeedTestOptions,
} from '@/services/speed'
import type { InteractableProxyMember } from '@/types/proxy-view'

export interface SpeedTestTarget {
  group: string
  names: string[]
  /** 组内可交互成员：测速启动时一并触发延迟测试 */
  members: InteractableProxyMember[]
}

interface Props {
  /** null 表示关闭；对话框关闭后测速可继续后台运行 */
  target: SpeedTestTarget | null
  onClose: () => void
}

export function SpeedTestViewer({ target, onClose }: Props) {
  const { t } = useTranslation()
  const runStatus = useSpeedRunStatus()
  const { verge } = useVerge()
  const [concurrency, setConcurrency] = useState(
    () => getStoredSpeedTestOptions().concurrency,
  )
  const [url, setUrl] = useState(() => getStoredSpeedTestOptions().url)

  // 每次打开时同步后端真实状态（支持刷新后重开恢复进度）
  useEffect(() => {
    if (target) void speedManager.refreshStatus()
  }, [target])

  const running = runStatus.running
  const progress =
    runStatus.total > 0
      ? Math.round((runStatus.completed / runStatus.total) * 100)
      : 0

  const onStart = useLockFn(async () => {
    if (!target) return
    storeSpeedTestOptions({ concurrency, url: url.trim() })

    // 顺带并发测一轮组内延迟（复用延迟测试管线，独立更新延迟徽章）
    if (target.members.length > 0) {
      const timeout = verge?.default_latency_timeout || 10000
      void delayManager.checkListDelay(target.members, target.group, timeout)
    }

    try {
      await speedManager.startTest(target.group, target.names, concurrency, url)
    } catch (error) {
      if (error instanceof SpeedTestBusyError) {
        showNotice.error('proxies.page.speedTest.messages.busy')
      } else {
        showNotice.error(
          'proxies.page.speedTest.messages.startFailed',
          error as Error,
        )
      }
    }
  })

  return (
    <BaseDialog
      open={!!target}
      title={t('proxies.page.speedTest.title')}
      contentSx={{ width: 420 }}
      okBtn={
        running
          ? t('proxies.page.speedTest.actions.stop')
          : t('proxies.page.speedTest.actions.start')
      }
      cancelBtn={t('shared.actions.close')}
      onClose={onClose}
      onCancel={onClose}
      onOk={() => {
        if (running) void speedManager.stopTest()
        else void onStart()
      }}
    >
      <List sx={{ width: '100%' }}>
        <ListItem sx={{ padding: '4px 0', minHeight: 36 }}>
          <ListItemText
            primary={t('proxies.page.speedTest.fields.group')}
            slotProps={{ primary: { sx: { fontSize: 12 } } }}
          />
          <Typography sx={{ fontSize: 13, maxWidth: 220 }} noWrap>
            {target?.group}
            <Typography component="span" sx={{ fontSize: 12, ml: 1 }}>
              {t('proxies.page.labels.nodeCount', {
                count: target?.names.length ?? 0,
              })}
            </Typography>
          </Typography>
        </ListItem>

        <ListItem sx={{ padding: '4px 0', minHeight: 36 }}>
          <ListItemText
            primary={t('proxies.page.speedTest.fields.concurrency')}
            slotProps={{ primary: { sx: { fontSize: 12 } } }}
          />
          <ToggleButtonGroup
            size="small"
            exclusive
            disabled={running}
            value={concurrency}
            onChange={(_, value) => {
              if (value) setConcurrency(value)
            }}
          >
            {SPEED_CONCURRENCY_OPTIONS.map((option) => (
              <ToggleButton key={option} value={option} sx={{ px: 1.5 }}>
                {option}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </ListItem>

        <ListItem sx={{ padding: '4px 0', alignItems: 'flex-start' }}>
          <TextField
            fullWidth
            size="small"
            autoComplete="off"
            autoSave="off"
            disabled={running}
            label={t('proxies.page.speedTest.fields.url')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            sx={{ mt: 1, fontSize: 12 }}
          />
        </ListItem>

        {running && (
          <ListItem sx={{ padding: '8px 0 2px', display: 'block' }}>
            <Typography sx={{ fontSize: 12, mb: 1 }}>
              {t('proxies.page.speedTest.status.progress', {
                completed: runStatus.completed,
                total: runStatus.total,
              })}
            </Typography>
            <LinearProgress variant="determinate" value={progress} />
          </ListItem>
        )}

        <ListItem sx={{ padding: '4px 0' }}>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            {t('proxies.page.speedTest.hints.traffic')}
            <br />
            {t('proxies.page.speedTest.hints.background')}
          </Typography>
        </ListItem>
      </List>
    </BaseDialog>
  )
}

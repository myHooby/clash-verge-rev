use super::{CmdResult, coded_error};
use crate::module::speed_test::{SpeedTestEvent, SpeedTestManager, SpeedTestStatus, StartFailure};
use tauri::{command, ipc::Channel};

/// 启动一轮按节点并发测速；结果经 `on_event` 增量回传
#[command]
pub async fn start_speed_test(
    group: String,
    names: Vec<String>,
    concurrency: u32,
    url: String,
    on_event: Channel<SpeedTestEvent>,
) -> CmdResult {
    map_start_failure(
        SpeedTestManager::global()
            .start(group, names, concurrency, url, on_event)
            .await,
    )
}

/// 取消进行中的测速（后台完成监听器恢复）
#[command]
pub fn stop_speed_test() {
    SpeedTestManager::global().stop();
}

/// 查询测速运行状态（对话框重开时恢复进度显示）
#[command]
pub fn get_speed_test_status() -> SpeedTestStatus {
    SpeedTestManager::global().status()
}

fn map_start_failure(result: Result<(), StartFailure>) -> CmdResult {
    match result {
        Ok(()) => Ok(()),
        Err(failure @ StartFailure::Busy) => Err(coded_error("speed-test/busy", failure)),
        Err(failure @ StartFailure::Invalid(_)) => Err(coded_error("speed-test/invalid", failure)),
        Err(failure @ StartFailure::Apply(_)) => Err(coded_error("speed-test/apply-failed", failure)),
    }
}

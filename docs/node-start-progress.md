# `neuromem node start` 7단계 진행 상황

상태: **기본 진행 상황 출력 구현 완료**

## 현재 동작

`neuromem node start`는 작업을 시작할 때마다 다음 7개 단계를 `stderr`에 한 줄씩 출력한다.

```text
[1/7] Node 설정을 확인합니다.
[2/7] 장치와 Docker 실행 환경을 확인합니다.
[3/7] Node 데이터 서비스를 시작합니다.
[4/7] Workspace와 Project 스키마를 준비합니다.
[5/7] 메모리·Control·MCP·Web 서비스를 시작합니다.
[6/7] 연결된 임베딩·생성 소스를 확인합니다.
[7/7] Node가 준비되었습니다.
```

각 줄은 해당 작업에 들어가기 직전에 출력된다. 단계별 실제 작업은 다음과 같다.

1. `node.env`가 없으면 생성하고 비공개 설정을 검증한다.
2. Mac 또는 DGX 대상을 판별하고 Docker·Compose 등 필수 실행 환경을 검사한다.
3. Control DB, Memory DB, Redis를 기동하고 준비될 때까지 기다린다.
4. Control 및 Memory Core의 Workspace·Project 스키마를 초기화한다.
5. Memory Core, Worker, Control, MCP, Web, Edge를 빌드·기동하고 상태를 확인한다.
6. 연결된 임베딩 및 생성 소스를 확인한다. 준비되지 않은 소스는 최종 결과의 `warnings`에 포함한다.
7. 준비 완료 단계를 출력하고 접속 주소, MCP 주소, 컴퓨팅 소스 상태를 최종 JSON으로 반환한다.

## 출력 계약

- 7단계 진행 줄은 `stderr`로 출력한다.
- 성공 결과 JSON은 기존 자동화가 파싱할 수 있도록 `stdout`으로 출력한다.
- 실패하면 마지막으로 시작된 단계 뒤에 오류 JSON을 `stderr`로 출력하고 종료 코드 `1`을 반환한다.
- 비밀번호, API 키, 서명키, 전체 환경 변수는 진행 줄이나 최종 결과에 출력하지 않는다.
- 실패하거나 `Ctrl+C`로 중단해도 Docker 볼륨과 기존 데이터는 자동 삭제하지 않는다.
- 퍼센트나 예상 시간은 계산하지 않는다. 단계 수와 실행 순서만 표시한다.

## 구현 위치

- `apps/manager/src/node-deployment-manager.ts`: 7단계 정의와 실제 작업 순서
- `apps/manager/src/cli.ts`: 진행 콜백을 `[현재/전체] 메시지` 형식으로 `stderr`에 출력
- `apps/manager/test/node-deployment-manager.test.ts`: Node 시작 순서와 데이터 보존 등 배포 동작 검증

## 추가 개선 후보

현재 구현은 각 단계의 **시작**만 한 줄로 알린다. 다음 항목은 아직 구현하지 않았다.

- 오래 걸리는 Docker pull·build·health 대기의 주기적 상태 갱신
- 단계별 `진행 중`·`완료`·`실패` 이벤트와 실패 서비스 요약
- 대화형 터미널의 한 줄 갱신 또는 상세 로그 전환
- `Ctrl+C` 중단 시 생성된 컨테이너와 재실행 명령 안내

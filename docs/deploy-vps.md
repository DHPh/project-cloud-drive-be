# CI/CD backend lên VPS

GitHub Actions kiểm tra pull request và lần push hoặc merge vào **main**. Job CI dùng Node.js 24 và PostgreSQL 17 cách ly để cài đặt từ lockfile, typecheck, build và test. Khi CI đạt, mỗi push vào **main** tự phát hành nếu SHA vẫn là đầu nhánh. **Run workflow** có thể dùng để thử lại commit hiện tại trên **main**. GitHub xếp hàng các lần triển khai và VPS khóa lệnh phát hành bằng `flock`. [Workflow](../.github/workflows/backend-release.yml)

## Chuẩn bị VPS một lần

1. Cấp Docker Engine, Docker Compose plugin, OpenSSH, sudo có hỗ trợ regex đối số, gzip và flock. Kiểm tra kiến trúc của VPS tương thích với image mà runner build.
2. Tạo bridge ngoài Compose bằng `docker network create cloud-drive-backend` nếu chưa có. Cấp PostgreSQL 17 và MinIO riêng cho production rồi kết nối cả hai vào bridge này với tên hoặc alias DNS ổn định. Dùng database riêng, bucket private unversioned và tài khoản MinIO có quyền đọc, ghi, liệt kê và xóa object trong bucket của ứng dụng. Giữ cổng PostgreSQL, MinIO và console trên mạng riêng. Kiểm tra DNS nội bộ và quyền trước khi phát hành. Môi trường fixture có thể chọn bridge riêng bằng biến `CLOUD_DRIVE_NETWORK` cấp cho tiến trình Compose.
3. Cài từ bản đã review vào `/opt/project-cloud-drive-be`, thư mục thuộc `root:root` và chỉ root có quyền sửa. Lưu `deploy/compose.production.yaml` với mode `0644`, các script `deploy/release.sh` và `deploy/ssh-entrypoint.sh` với mode `0755` và xuống dòng LF, cùng `api.env` với mode `0600`. Tên tệp trên VPS giữ nguyên, bỏ tiền tố thư mục `deploy/`. Người vận hành cập nhật các tệp khi thay đổi cấu hình hoặc logic phát hành. [Compose](../deploy/compose.production.yaml) · [Script phát hành](../deploy/release.sh) · [SSH entry point](../deploy/ssh-entrypoint.sh)
4. Tạo tài khoản SSH triển khai riêng như `cloud-drive-deploy`, với khả năng chạy forced command và mật khẩu bị khóa. Giữ tài khoản ngoài nhóm Docker. Tệp `authorized_keys` do root quản lý, dùng khóa riêng của runner cùng options `restrict,command="/opt/project-cloud-drive-be/ssh-entrypoint.sh"`. Entry point chỉ chấp nhận `deploy <SHA>` rồi chuyển tiếp cho `sudo`.
5. Tạo một tệp sudoers riêng do root sở hữu. Dùng tên tài khoản thật tương ứng với `DEPLOY_USER` và kiểm tra cú pháp bằng `visudo -cf`. Rule dưới đây chỉ cấp quyền chạy script cố định với đúng một SHA gồm 40 ký tự hex viết thường. Script nhận image đã nén qua stdin và tự xác thực số đối số, SHA và nhãn revision của image.

~~~sudoers
cloud-drive-deploy ALL=(root) NOPASSWD: /opt/project-cloud-drive-be/release.sh ^[0-9a-f]{40}$
~~~

## Cấu hình production

Đặt các biến sau trong `/opt/project-cloud-drive-be/api.env`. Cấp giá trị thật từ cấu hình riêng của VPS.

| Biến | Giá trị |
| --- | --- |
| `APP_ORIGIN` | Chính xác origin HTTPS mà người dùng sẽ mở trên Vercel hoặc domain frontend đã gắn. Dùng origin ứng dụng gồm scheme và hostname, bỏ path và dấu gạch chéo cuối. |
| `DATABASE_URL` | Kết nối PostgreSQL từ trong mạng container tới database riêng. Lần chạy migration cần quyền tạo và thay đổi schema. |
| `S3_ENDPOINT` | Origin MinIO mà container API truy cập được qua mạng riêng. |
| `S3_REGION`, `S3_BUCKET` | Region và tên bucket production đã cấp. |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Credential giới hạn quyền vào bucket của ứng dụng, cấp riêng trên VPS. |
| `TRUSTED_PROXY_RANGES` | Chỉ đặt khi đã xác minh địa chỉ proxy API thực sự nhận qua bridge và cách proxy chuẩn hóa header chuyển tiếp. |
| `SESSION_TTL_HOURS`, `MAX_UPLOAD_BYTES`, `UPLOAD_RECOVERY_AGE_SECONDS` | Tùy chỉnh khi cần, theo giới hạn backend và đường truyền qua proxy thực tế. |

Compose đặt `NODE_ENV=production`, `HOST=0.0.0.0` và `PORT=3001` trong container. Trên VPS, API chỉ bind HTTP tại `127.0.0.1:13001`. Khi domain API và DNS sẵn sàng, thêm site HTTPS trong Caddy trên VPS và đưa upstream về đúng cổng loopback.

~~~caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:13001
}
~~~

Cấu hình `CLOUD_DRIVE_API_ORIGIN` trong Vercel thành origin HTTPS của API, rồi triển khai lại frontend để rewrite cùng origin có hiệu lực. Lấy `APP_ORIGIN` từ URL truy cập ứng dụng thật trên Vercel. URL mở giao diện quản trị dự án Vercel chỉ dùng để quản lý. Backend kiểm tra origin cho request ghi và bật cookie Secure với HTTPS. [Cấu hình backend](../src/config.ts) · [Quy ước HTTP](contracts/README.md#quy-ước-http)

## Biến và secret GitHub Actions

Trong repo backend, mở **Settings → Secrets and variables → Actions** và cấu hình ở cấp repo.

| Loại | Tên | Giá trị |
| --- | --- | --- |
| Variable | `DEPLOY_HOST` | Tên DNS hoặc IPv4 mà runner truy cập được. Cấp hostname thật của VPS dùng cho SSH. |
| Variable | `DEPLOY_PORT` | Cổng SSH, mặc định `22` khi để trống. |
| Variable | `DEPLOY_USER` | Tên tài khoản SSH triển khai đã cấp trên VPS. |
| Variable | `DEPLOY_HEALTH_URL` | URL HTTPS công khai của backend kết thúc bằng `/health`. |
| Secret | `DEPLOY_SSH_PRIVATE_KEY` | Private key dành riêng cho runner, với public key tương ứng đã cài cho tài khoản triển khai. |
| Secret | `DEPLOY_SSH_KNOWN_HOSTS` | Dòng known_hosts đầy đủ của chính VPS. Cấp hostname hoặc IPv4 giống `DEPLOY_HOST` ở cổng 22, hoặc dạng `[host]:port` với cổng khác. Dòng chứa loại khóa và public host key thực tế của máy. |

Lấy public host key thật qua phiên quản trị hoặc console đã xác thực. Đối chiếu fingerprint qua kênh tin cậy trước khi lưu dòng known_hosts. Runner dùng `StrictHostKeyChecking=yes`, khóa triển khai riêng và `BatchMode=yes`. Job triển khai dùng secret SSH sau khi CI trên `main` đạt. Credential của PostgreSQL và MinIO cùng `APP_ORIGIN` được cung cấp qua `api.env` trên VPS. `CLOUD_DRIVE_API_ORIGIN` được cung cấp qua Vercel.

## Chạy và kiểm tra release

1. Trước khi merge thay đổi migration có rủi ro dữ liệu, xác nhận cấu hình trên VPS và cặp backup PostgreSQL/MinIO. Dùng cửa sổ dừng ghi của runbook cho bản sao cùng điểm khôi phục.
2. Push hoặc merge vào **main** và theo dõi **Backend CI and release**. Job build image `cloud-drive-be:<SHA>`, xác nhận SHA còn là đầu nhánh rồi gửi qua SSH cho script trên VPS. Script kiểm tra cấu hình, dừng API, chạy `node dist/cli.js migrate` bằng container một lần, rồi khởi động API và chờ healthcheck. `/opt/project-cloud-drive-be/current-image` được cập nhật sau khi API qua kiểm tra cục bộ.
3. Job chỉ thành công khi `/health` qua HTTPS trả `ready`. Healthcheck xác nhận API và PostgreSQL. Kiểm tra MinIO riêng bằng audit chỉ đọc với cấu hình production hoặc bằng luồng upload/tải đúng byte bằng tài khoản được phép. [Runbook đối soát](operations.md#đối-soát-chỉ-đọc)
4. Sau migration đầu tiên, người vận hành tạo admin một lần theo [lệnh bootstrap](#tạo-admin-đầu-tiên). Đăng nhập qua frontend thật, kiểm tra phiên sau reload rồi tạo tài khoản tiếp theo bằng link mời.
5. Kiểm tra nhanh upload, tải xuống, tên Unicode, thu hồi quyền và quyền tải công khai qua URL frontend. Thử với tệp gần giới hạn dự kiến khi domain và Vercel rewrite đã sẵn sàng. Ghi SHA, phiên bản OpenAPI, thời điểm rollout và các bước đã kiểm tra. [Bộ ca phát hành](verification.md)

Trạng thái kiểm chứng VPS, domain và origin frontend được ghi sau khi hạ tầng thực tế sẵn sàng và các bước trên đã chạy.

## Tạo admin đầu tiên

Trong phiên quản trị VPS có quyền vận hành Docker, chạy bằng Bash. Câu lệnh đọc mật khẩu ẩn trong tiến trình con và truyền tên biến môi trường vào container một lần.

~~~bash
(
    set -e
    cd /opt/project-cloud-drive-be
    export CLOUD_DRIVE_IMAGE="$(cat current-image)"
    export CLOUD_DRIVE_API_ENV_FILE="$PWD/api.env"
    read -r -p "Email admin: " BOOTSTRAP_ADMIN_EMAIL
    read -r -p "Tên admin: " BOOTSTRAP_ADMIN_NAME
    read -r -s -p "Mật khẩu admin: " BOOTSTRAP_ADMIN_PASSWORD
    printf '\n'
    export BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_NAME BOOTSTRAP_ADMIN_PASSWORD
    docker compose -f compose.production.yaml run --rm --no-deps -T \
        -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_NAME -e BOOTSTRAP_ADMIN_PASSWORD \
        api node dist/bootstrap-admin.js
)
~~~

## Khi release lỗi

Giữ log của lần chạy và tên image đã ghi trong `current-image`. Nếu lỗi xảy ra sau khi dừng API, giữ cửa sổ bảo trì và kiểm tra kết quả migration trước khi mở lại traffic. API cũ có thể khởi động lại từ image đã ghi nếu xác nhận schema hiện tại tương thích. Nếu schema hoặc dữ liệu cần quay lui, phục hồi PostgreSQL và MinIO từ cùng cặp backup theo runbook. Với lần triển khai đầu tiên, xử lý nguyên nhân hoặc phục hồi môi trường trước khi chạy lại release. [Sao lưu](operations.md#tạo-bộ-backup-ở-cùng-điểm-khôi-phục) · [Phục hồi](operations.md#diễn-tập-restore-và-quay-lui)

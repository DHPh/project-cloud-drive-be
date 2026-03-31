# Runbook đối soát và phục hồi lưu trữ

## Đối soát chỉ đọc

Chuẩn bị backend đã build và đã áp migration phù hợp. Cấp qua môi trường `DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY` và `S3_SECRET_KEY`. Dùng kết nối PostgreSQL được đọc `users`, `files` và `trash_purge_files`, cùng quyền liệt kê bucket ở prefix `files/`. Từ gốc repo backend, chạy `node dist/cli.js audit`. Xem [cách tính và phân loại](design.md#đối-soát-lưu-trữ-ops-01).

| Mã thoát | Ý nghĩa và thao tác tiếp theo |
| --- | --- |
| `0` | Quét xong và chưa thấy lệch cần xác minh. Lưu ID lần quét và số lượng đã kiểm tra. |
| `2` | Quét xong và phát hiện trường hợp cần xác minh. Kiểm tra `findings`, lịch thao tác và báo cáo lần quét trước. Quét lại trong cửa sổ dừng ghi trước khi sửa dữ liệu. |
| `1` | Chưa hoàn thành lượt quét. Kiểm tra kết nối, quyền đọc, migration và khả năng liệt kê bucket, rồi chạy lại. |

Báo cáo ghi số bản ghi tệp, tài khoản, trang và object đã quét. `pendingObjects`, `cleanupObjects` và `purgeQueuedObjects` là object có metadata theo dõi ở trạng thái chuyển tiếp. `recentUnreferencedObjects` nằm trong khoảng chờ upload. `suspectedOrphanObjects` cần xác minh lại trước khi dọn, nhất là khi đang có ghi hoặc xóa. Đối soát hiện thấy phiên bản object đang được liệt kê. Dùng manifest của bản sao lưu để kiểm tra thêm checksum và nội dung.

Mẫu trong báo cáo giới hạn 20 cho mỗi loại lệch. Mã tham chiếu dùng 24 ký tự hex đầu của SHA-256 với tiền tố `object:` hoặc `account:`. Chỉ đối chiếu với key hoặc ID biết trước trong môi trường có quyền. Khi chia sẻ bằng chứng, dùng dữ liệu tổng hợp và giữ secret, tên tệp, ID và object key thật ngoài log đính kèm. Các tác vụ thử lại upload và xóa vĩnh viễn tiếp tục theo [vòng đời riêng](design.md#vòng-đời-upload).

## Tạo bộ backup ở cùng điểm khôi phục

1. Ghi ID bộ backup, môi trường, SHA backend/frontend và phiên bản schema. Đặt dung lượng và thời gian dừng ghi theo kết quả diễn tập. Chuẩn bị kho backup riêng có kiểm soát quyền truy cập.
2. Dừng nhận thao tác ghi và dừng worker tác động PostgreSQL hoặc MinIO. Đợi lượt ghi đang xử lý kết thúc. Ghi lại thời điểm bắt đầu cửa sổ và trạng thái công việc để hai bản sao có thể đối chiếu.
3. Sao lưu PostgreSQL ở định dạng custom, ví dụ với kết nối libpq đã cấu hình qua môi trường và file thông tin xác thực có quyền phù hợp.

   ```sh
   pg_dump --format=custom --file="$PG_BACKUP"
   ```

4. Trong cùng cửa sổ, chụp snapshot hoặc sao chép object sang nơi lưu riêng, giữ nguyên từng key và byte. Ghi cấu hình bucket cần phục hồi, số object, byte và manifest để kiểm tra mẫu bằng checksum. Cặp snapshot PostgreSQL và MinIO dùng chung ID bộ backup.
5. Kiểm tra có đủ hai bản sao, manifest và bản ghi phiên bản trước khi mở ghi. Ghi lúc kết thúc và lưu bộ backup theo chính sách của môi trường.

## Diễn tập restore và quay lui

1. Cấp database trống và bucket private riêng trong môi trường cách ly. Chuẩn bị vai trò PostgreSQL và quyền truy cập bucket theo cấu hình đích, vì bản dump từng database dùng các vai trò đã được cấp. Trỏ cấu hình sang hai đích phục hồi và kiểm tra tên môi trường trước khi chạy lệnh. Giữ kết nối sản xuất ngoài buổi diễn tập.
2. Nạp snapshot PostgreSQL, ví dụ với `RESTORE_DATABASE` là tên database đích và kết nối libpq của môi trường cách ly.

   ```sh
   pg_restore --exit-on-error --dbname="$RESTORE_DATABASE" "$PG_BACKUP"
   ```

3. Nạp object từ đúng cặp backup theo key cũ. Xác nhận số object và byte với manifest. Khởi động phiên bản ứng dụng tương thích với schema phục hồi, hoặc chạy migration đã diễn tập theo thứ tự được ghi trong bản phát hành.
4. Chạy audit trên hai bản đã phục hồi trước khi mở lại luồng ghi. Kiểm tra quyền đăng nhập, tải lại đúng byte và tên, quota và trạng thái Thùng rác bằng fixture. Bật công việc nền theo kế hoạch và kiểm tra việc thử lại vẫn dùng trạng thái đã lưu.
5. Ghi ID backup, SHA, schema, thời gian khôi phục, kết quả audit và kiểm tra mẫu. Khi cần quay lui, ưu tiên bản ứng dụng dùng được với schema hiện tại. Nếu cần phục hồi dữ liệu, dùng cả hai bản sao với cùng điểm khôi phục, xác nhận kết quả trên môi trường tách biệt rồi mới mở traffic theo kế hoạch.

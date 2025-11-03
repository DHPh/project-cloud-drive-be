# Thiết kế backend

**Trạng thái: dự thảo.** Đọc [hợp đồng HTTP](../../docs/contracts/README.md) để triển khai route và DTO.

- **Quyền:** xác thực phiên và kiểm tra quyền tài nguyên ở use case. Quyết định cho phép đọc hoặc sửa dựa trên người dùng, trạng thái tài nguyên và quyền hiện hành. DTO xuất ra chỉ chứa trường cần cho chức năng gọi nó.
- **Upload và quota:** validate đầu vào và quyền thư mục trước khi ghi object. Giữ quota bằng cập nhật nguyên tử, ghi metadata theo trạng thái xử lý, và có đường dọn hoặc thử lại khi MinIO và PostgreSQL cập nhật lệch nhau. Kiểm thử trường hợp hai upload đồng thời.
- **Download và preview:** dùng bucket private. Stream dữ liệu sau khi kiểm tra quyền, xử lý tên Unicode đúng header và tránh shared cache cho tệp riêng tư. HTML preview cần tạo nội dung bất hoạt và cô lập khỏi phiên ứng dụng.
- **Thùng rác:** giữ ID tài nguyên và quan hệ qua soft delete. Dọn object qua luồng có thể retry và đối soát quota. Xem quyết định sản phẩm ở [TRASH-01](../../docs/use-cases.md#trash-01--xóa-khôi-phục-và-dọn-thùng-rác).
- **Schema:** migration là đường tạo và nâng cấp DB. Kiểm tra migration trên DB trống và trên snapshot fixture khi có dữ liệu cũ. Ghi cách phục hồi theo thay đổi dữ liệu cụ thể.

# Chỉ dẫn backend

- Đọc [thiết kế backend](docs/design.md) trước khi đổi quyền, quota, storage hoặc migration.
- Giữ [OpenAPI](../docs/contracts/openapi.yaml) khớp route và DTO. Khi đổi hành vi, kiểm chứng ở ranh giới HTTP lẫn dữ liệu bị tác động.
- Với upload hoặc xóa, ghi rõ điều gì xảy ra khi chỉ một trong hai hệ thống PostgreSQL và MinIO cập nhật thành công. Kiểm tra retry và trạng thái cuối trên dữ liệu tổng hợp.

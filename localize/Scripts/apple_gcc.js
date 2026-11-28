let body = $response.body;
if (body) {
    // 强制将返回的国家代码修改为 US
    body = "US";
}
$done({ body });

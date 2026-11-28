let url = $request.url.replace(/country_code=[A-Z]{2}/i, "country_code=US");
$done({ url });
